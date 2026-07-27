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

import { getUserModelSettings } from "./userSettings";
import { DEFAULT_TABULAR_MODEL, DEFAULT_TITLE_MODEL } from "./llm";

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
): OrganisationModelContext {
  return {
    id: "org-1",
    allowMemberModelPrefs,
    config: { defaultModel, offeredProviders: [] },
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
