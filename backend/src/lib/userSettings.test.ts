import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganisationModelContext } from "./organisations";

// Control state for the mocked firm model-context lookup. `resolve` is what
// getUserOrganisationModelContext returns; `throws` makes it reject (fail-open).
const state = vi.hoisted(() => ({
  resolve: null as OrganisationModelContext | null,
  throws: false,
}));

vi.mock("./supabase", () => ({
  createServerSupabase: () => ({}),
}));

// No personal keys → resolveTitleModel falls back to DEFAULT_TITLE_MODEL.
vi.mock("./userApiKeys", () => ({
  getUserApiKeys: () => Promise.resolve({}),
}));

vi.mock("./organisations", () => ({
  getUserOrganisationModelContext: () => {
    if (state.throws) return Promise.reject(new Error("db down"));
    return Promise.resolve(state.resolve);
  },
}));

import { getUserModelSettings, resolveOrgChatModel } from "./userSettings";
import {
    DEFAULT_MAIN_MODEL,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
} from "./llm";

// Fake db exposing just the personal-prefs read getUserModelSettings performs.
function fakeDb(personal: {
  title_model: string | null;
  tabular_model: string | null;
}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: personal, error: null }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function context(
  allowMemberModelPrefs: boolean,
  defaultModel: string | null = null,
  offeredProviders: string[] = [],
): OrganisationModelContext {
  return {
    id: "org-1",
    allowMemberModelPrefs,
    config: { defaultModel, offeredProviders },
  };
}

const PERSONAL = {
  title_model: "claude-haiku-4-5",
  tabular_model: "claude-sonnet-4-6",
};

beforeEach(() => {
  state.resolve = null;
  state.throws = false;
});

describe("getUserModelSettings — firm model policy (WS8 PR F)", () => {
  it("uses the firm default model for tabular when memberModelPrefs is off", async () => {
    state.resolve = context(false, "gpt-5.4");
    const out = await getUserModelSettings("u1", fakeDb(PERSONAL));
    // Personal tabular pref is inert; the firm default governs.
    expect(out.tabular_model).toBe("gpt-5.4");
    // Title stays on the provider-appropriate lightweight default (personal
    // title pref ignored).
    expect(out.title_model).toBe(DEFAULT_TITLE_MODEL);
  });

  it("falls back to the tabular default when the firm sets no default", async () => {
    state.resolve = context(false, null);
    const out = await getUserModelSettings("u1", fakeDb(PERSONAL));
    expect(out.tabular_model).toBe(DEFAULT_TABULAR_MODEL);
    expect(out.title_model).toBe(DEFAULT_TITLE_MODEL);
  });

  it("honours personal prefs when memberModelPrefs is on", async () => {
    state.resolve = context(true, "gpt-5.4");
    const out = await getUserModelSettings("u1", fakeDb(PERSONAL));
    expect(out.tabular_model).toBe("claude-sonnet-4-6");
    expect(out.title_model).toBe("claude-haiku-4-5");
  });

  it("honours personal prefs for an orgless user (no context)", async () => {
    state.resolve = null;
    const out = await getUserModelSettings("u1", fakeDb(PERSONAL));
    expect(out.tabular_model).toBe("claude-sonnet-4-6");
    expect(out.title_model).toBe("claude-haiku-4-5");
  });

  it("fails open to personal prefs when the firm lookup throws", async () => {
    state.throws = true;
    const out = await getUserModelSettings("u1", fakeDb(PERSONAL));
    expect(out.tabular_model).toBe("claude-sonnet-4-6");
    expect(out.title_model).toBe("claude-haiku-4-5");
  });
});

describe("resolveOrgChatModel — firm chat-model clamp (WS8 PR F)", () => {
  it("forces the firm default for an arbitrary out-of-catalogue id under policy OFF", async () => {
    state.resolve = context(false, "gpt-5.4");
    const out = await resolveOrgChatModel("u1", "totally-made-up-model");
    expect(out).toBe("gpt-5.4");
  });

  it("forces the firm default even over a valid different model under policy OFF", async () => {
    state.resolve = context(false, "gpt-5.4");
    const out = await resolveOrgChatModel("u1", "claude-fable-5");
    expect(out).toBe("gpt-5.4");
  });

  it("substitutes a disallowed provider under policy ON + offeredProviders", async () => {
    // Offered: gemini only; firm default gemini-3-flash-preview. A claude pick
    // is out of set → substituted to the firm default (an offered provider).
    state.resolve = context(true, "gemini-3-flash-preview", ["gemini"]);
    const out = await resolveOrgChatModel("u1", "claude-fable-5");
    expect(out).toBe("gemini-3-flash-preview");
  });

  it("substitutes to a default main model when no firm default is set", async () => {
    // Offered: gemini; no firm default. The default main model is gemini, which
    // is offered, so it is used.
    state.resolve = context(true, null, ["gemini"]);
    const out = await resolveOrgChatModel("u1", "claude-fable-5");
    expect(out).toBe(DEFAULT_MAIN_MODEL);
  });

  it("substitutes to the first offered provider's default when the default main model is not offered", async () => {
    // Offered: openai only; no firm default; default main model (gemini) is not
    // offered → first offered provider's default main model (gpt-5.5).
    state.resolve = context(true, null, ["openai"]);
    const out = await resolveOrgChatModel("u1", "claude-fable-5");
    expect(out).toBe("gpt-5.5");
  });

  it("leaves an already-offered provider unchanged", async () => {
    state.resolve = context(true, "gpt-5.5", ["gemini", "openai"]);
    const out = await resolveOrgChatModel("u1", "gpt-5.4");
    expect(out).toBe("gpt-5.4");
  });

  it("passes a local model id through untouched, even under policy OFF", async () => {
    state.resolve = context(false, "gpt-5.4", ["openai"]);
    const out = await resolveOrgChatModel("u1", "local:llama-3.3-70b");
    expect(out).toBe("local:llama-3.3-70b");
  });

  it("fails open to the requested model when the org lookup throws", async () => {
    state.throws = true;
    const out = await resolveOrgChatModel("u1", "claude-fable-5");
    expect(out).toBe("claude-fable-5");
  });

  it("leaves the requested model unchanged for an orgless caller", async () => {
    state.resolve = null;
    const out = await resolveOrgChatModel("u1", "claude-fable-5");
    expect(out).toBe("claude-fable-5");
  });

  it("returns the firm default for an undefined client model under policy OFF", async () => {
    state.resolve = context(false, "gpt-5.4");
    const out = await resolveOrgChatModel("u1", undefined);
    expect(out).toBe("gpt-5.4");
  });

  it("leaves an undefined client model unchanged when unrestricted (policy ON)", async () => {
    state.resolve = context(true, null, []);
    const out = await resolveOrgChatModel("u1", undefined);
    expect(out).toBeUndefined();
  });
});
