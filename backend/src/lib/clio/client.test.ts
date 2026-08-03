import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClioDb } from "./fakeClioDb";
import { saveClioConnection, loadClioConnection } from "./connections";
import {
  ClioAuthError,
  ClioRateLimitError,
  clioRequest,
  isRateLimitExhausted,
  parseRetryAfterMs,
  refreshClioConnection,
  resetClioClientStateForTests,
} from "./client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (db: unknown) => db as any;

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function seed(product: "manage" | "grow" = "manage") {
  const db = makeClioDb();
  await saveClioConnection(asDb(db), {
    userId: "user-1",
    product,
    tokens: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      // Far future so no proactive refresh fires.
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      scope: null,
    },
  });
  return db;
}

beforeEach(() => {
  resetClioClientStateForTests();
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-clio-secret-value";
  process.env.CLIO_CLIENT_ID = "m-id";
  process.env.CLIO_CLIENT_SECRET = "m-secret";
  process.env.CLIO_GROW_CLIENT_ID = "g-id";
  process.env.CLIO_GROW_CLIENT_SECRET = "g-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });
  it("parses an HTTP-date into a non-negative delay", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(0);
  });
  it("is null for absent/garbage values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});

describe("isRateLimitExhausted", () => {
  it("is true only when remaining is present and <= 0", () => {
    expect(
      isRateLimitExhausted(new Headers({ "x-ratelimit-remaining": "0" })),
    ).toBe(true);
    expect(
      isRateLimitExhausted(new Headers({ "x-ratelimit-remaining": "5" })),
    ).toBe(false);
    expect(isRateLimitExhausted(new Headers())).toBe(false);
  });
});

describe("clioRequest — auth", () => {
  it("throws ClioAuthError when the user is not connected", async () => {
    const db = makeClioDb();
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      clioRequest(asDb(db), "user-1", "manage", "/matters.json"),
    ).rejects.toBeInstanceOf(ClioAuthError);
  });

  it("refreshes once and retries after a 401, then succeeds", async () => {
    const db = await seed("manage");
    let dataCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/oauth/token")) {
          return json({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 2592000,
          });
        }
        dataCalls += 1;
        if (dataCalls === 1) return json({ error: "expired" }, 401);
        return json({ data: [{ id: 1 }] });
      }),
    );
    const body = (await clioRequest(
      asDb(db),
      "user-1",
      "manage",
      "/matters.json",
      {
        fields: "id",
      },
    )) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
    // The refreshed token was persisted.
    const reloaded = await loadClioConnection(asDb(db), "user-1", "manage");
    expect(reloaded?.tokens.accessToken).toBe("access-2");
  });

  it("throws ClioAuthError when the refresh itself fails on a 401", async () => {
    const db = await seed("manage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/oauth/token")) return json({ error: "bad" }, 400);
        return json({ error: "expired" }, 401);
      }),
    );
    await expect(
      clioRequest(asDb(db), "user-1", "manage", "/matters.json"),
    ).rejects.toBeInstanceOf(ClioAuthError);
  });
});

describe("clioRequest — rate limiting", () => {
  it("throws ClioRateLimitError on a 429 with no honourable Retry-After", async () => {
    const db = await seed("manage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "slow down" }, 429)),
    );
    await expect(
      clioRequest(asDb(db), "user-1", "manage", "/matters.json"),
    ).rejects.toBeInstanceOf(ClioRateLimitError);
  });

  it("throws ClioRateLimitError once the shared Grow bucket (3/s) is exhausted", async () => {
    const db = await seed("grow");
    // Freeze the clock so the per-second bucket cannot refill between the
    // (real-CPU-time) decrypt work of each call — otherwise the test is timing
    // flaky. Reconstruct the bucket under the frozen clock.
    vi.useFakeTimers();
    resetClioClientStateForTests();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ data: [] })),
      );
      // 3 succeed, the 4th is refused locally before hitting the network.
      await clioRequest(asDb(db), "user-1", "grow", "/matters");
      await clioRequest(asDb(db), "user-1", "grow", "/matters");
      await clioRequest(asDb(db), "user-1", "grow", "/matters");
      await expect(
        clioRequest(asDb(db), "user-1", "grow", "/matters"),
      ).rejects.toBeInstanceOf(ClioRateLimitError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshClioConnection — rotation", () => {
  it("persists a rotated Grow refresh token from the response", async () => {
    const db = await seed("grow");
    const connection = await loadClioConnection(asDb(db), "user-1", "grow");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          access_token: "access-2",
          refresh_token: "refresh-rotated",
          expires_in: 86400,
        }),
      ),
    );
    const updated = await refreshClioConnection(asDb(db), connection!);
    expect(updated.tokens.refreshToken).toBe("refresh-rotated");
  });

  it("retains the old refresh token when the response omits one (Manage non-rotating)", async () => {
    const db = await seed("manage");
    const connection = await loadClioConnection(asDb(db), "user-1", "manage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ access_token: "access-2", expires_in: 2592000 }),
      ),
    );
    const updated = await refreshClioConnection(asDb(db), connection!);
    expect(updated.tokens.accessToken).toBe("access-2");
    expect(updated.tokens.refreshToken).toBe("refresh-1");
  });
});
