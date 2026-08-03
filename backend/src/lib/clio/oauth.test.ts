import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClioDb } from "./fakeClioDb";
import {
  ClioOAuthError,
  completeClioOAuth,
  resetClioOAuthStateForTests,
  startClioOAuth,
} from "./oauth";
import { loadClioConnection } from "./connections";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (db: unknown) => db as any;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records every token-endpoint request body so PKCE presence can be asserted. */
function stubClioFetch(tokenBodies: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        tokenBodies.push(String(init?.body ?? ""));
        return json({
          access_token: "access-tok",
          refresh_token: "refresh-tok",
          expires_in: 2_592_000,
        });
      }
      if (u.includes("who_am_i")) {
        return json({ data: { id: 99, name: "Jane Solicitor" } });
      }
      return json({}, 404);
    }),
  );
}

function stateFromAuthorizeUrl(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get("state") ?? "";
}

beforeEach(() => {
  resetClioOAuthStateForTests();
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-clio-secret-value";
  process.env.API_PUBLIC_URL = "https://api.jessicaoss.com";
  process.env.CLIO_CLIENT_ID = "m-id";
  process.env.CLIO_CLIENT_SECRET = "m-secret";
  process.env.CLIO_GROW_CLIENT_ID = "g-id";
  process.env.CLIO_GROW_CLIENT_SECRET = "g-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startClioOAuth", () => {
  it("throws when the product's OAuth app is not configured", () => {
    delete process.env.CLIO_CLIENT_ID;
    expect(() => startClioOAuth("user-1", "manage")).toThrow(ClioOAuthError);
  });

  it("builds a Manage authorize URL WITHOUT scope or PKCE", () => {
    const { authorizationUrl } = startClioOAuth("user-1", "manage");
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://eu.app.clio.com/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("m-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.jessicaoss.com/clio/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("builds a Grow authorize URL WITH scope + PKCE S256", () => {
    const { authorizationUrl } = startClioOAuth("user-1", "grow");
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://eu.auth.api.clio.com/oauth/authorize",
    );
    expect(url.searchParams.get("scope")).toContain("grow_matter_read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });
});

describe("completeClioOAuth — state validation", () => {
  it("rejects a state that was never issued", async () => {
    const db = makeClioDb();
    stubClioFetch([]);
    await expect(
      completeClioOAuth("manage", "bogus-state", "code", asDb(db)),
    ).rejects.toBeInstanceOf(ClioOAuthError);
  });

  it("rejects when the callback product does not match the state's product", async () => {
    const db = makeClioDb();
    stubClioFetch([]);
    const { authorizationUrl } = startClioOAuth("user-1", "manage");
    const state = stateFromAuthorizeUrl(authorizationUrl);
    await expect(
      completeClioOAuth("grow", state, "code", asDb(db)),
    ).rejects.toBeInstanceOf(ClioOAuthError);
  });

  it("rejects a replayed state (one-time use)", async () => {
    const db = makeClioDb();
    const bodies: string[] = [];
    stubClioFetch(bodies);
    const { authorizationUrl } = startClioOAuth("user-1", "manage");
    const state = stateFromAuthorizeUrl(authorizationUrl);
    await completeClioOAuth("manage", state, "code", asDb(db));
    await expect(
      completeClioOAuth("manage", state, "code", asDb(db)),
    ).rejects.toBeInstanceOf(ClioOAuthError);
  });
});

describe("completeClioOAuth — happy path", () => {
  it("exchanges the code, snapshots identity, and saves the Manage connection", async () => {
    const db = makeClioDb();
    const bodies: string[] = [];
    stubClioFetch(bodies);
    const { authorizationUrl } = startClioOAuth("user-1", "manage");
    const state = stateFromAuthorizeUrl(authorizationUrl);

    const result = await completeClioOAuth(
      "manage",
      state,
      "the-code",
      asDb(db),
    );
    expect(result.userId).toBe("user-1");
    expect(result.product).toBe("manage");
    expect(result.connection.clioUserName).toBe("Jane Solicitor");
    expect(result.connection.clioUserId).toBe("99");

    // Manage's exchange carries NO code_verifier.
    expect(bodies[0]).toContain("grant_type=authorization_code");
    expect(bodies[0]).not.toContain("code_verifier");

    const loaded = await loadClioConnection(asDb(db), "user-1", "manage");
    expect(loaded?.tokens.accessToken).toBe("access-tok");
    expect(loaded?.tokens.refreshToken).toBe("refresh-tok");
  });

  it("includes the PKCE code_verifier in a Grow exchange", async () => {
    const db = makeClioDb();
    const bodies: string[] = [];
    stubClioFetch(bodies);
    const { authorizationUrl } = startClioOAuth("user-1", "grow");
    const state = stateFromAuthorizeUrl(authorizationUrl);
    await completeClioOAuth("grow", state, "the-code", asDb(db));
    expect(bodies[0]).toContain("code_verifier=");
  });
});
