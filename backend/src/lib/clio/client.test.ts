import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClioDb } from "./fakeClioDb";
import {
  saveClioConnection,
  loadClioConnection,
  getClioConnectionSummaries,
} from "./connections";
import {
  ClioAuthError,
  ClioRateLimitError,
  clioRequest,
  isRateLimitExhausted,
  parseRateLimitResetMs,
  parseRetryAfterMs,
  refreshClioConnection,
  resetClioClientStateForTests,
} from "./client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (db: unknown) => db as any;

// Most tests here perform real scrypt AES-256-GCM key derivation via
// saveClioConnection/loadClioConnection (the seed helper). Real KDF work
// under concurrent machine load (parallel agent suites) has blown 5s AND 20s
// ceilings while passing in isolation — that flake is contention, not a
// defect (DURABLE_LESSONS 2026-08-05), so the ceiling is deliberately
// generous.
vi.setConfig({ testTimeout: 120_000 });

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
    // A non-invalid_grant refresh failure is treated as transient — the row is
    // retained so a later attempt can recover.
    expect(
      await loadClioConnection(asDb(db), "user-1", "manage"),
    ).not.toBeNull();
  });

  it("prunes the stored connection when the refresh grant is rejected (invalid_grant)", async () => {
    const db = await seed("manage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/oauth/token")) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json({ error: "expired" }, 401);
      }),
    );
    await expect(
      clioRequest(asDb(db), "user-1", "manage", "/matters.json"),
    ).rejects.toBeInstanceOf(ClioAuthError);
    // The dead grant is deleted so status self-heals to disconnected.
    expect(await loadClioConnection(asDb(db), "user-1", "manage")).toBeNull();
    const summaries = await getClioConnectionSummaries(asDb(db), "user-1");
    expect(summaries.manage.connected).toBe(false);
  });

  it("does NOT prune when the refresh fails on a network error (transient)", async () => {
    const db = await seed("manage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/oauth/token")) throw new Error("network down");
        return json({ error: "expired" }, 401);
      }),
    );
    await expect(
      clioRequest(asDb(db), "user-1", "manage", "/matters.json"),
    ).rejects.toBeInstanceOf(ClioAuthError);
    // A transient/network refresh failure must leave the connection intact.
    expect(
      await loadClioConnection(asDb(db), "user-1", "manage"),
    ).not.toBeNull();
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

describe("proactive rate-limit backoff", () => {
  it("parseRateLimitResetMs handles epoch, delta, and absent", () => {
    const now = 1_000_000_000_000;
    expect(
      parseRateLimitResetMs(
        new Headers({ "x-ratelimit-reset": "1700000000" }),
        now,
      ),
    ).toBe(1_700_000_000_000);
    expect(
      parseRateLimitResetMs(new Headers({ "x-ratelimit-reset": "30" }), now),
    ).toBe(now + 30_000);
    expect(parseRateLimitResetMs(new Headers(), now)).toBeNull();
  });

  it("pre-empts the next call after a response drains the window (fails fast over cap)", async () => {
    const db = await seed("manage");
    let dataCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        dataCalls += 1;
        // remaining 0, reset in 10s (> 3s cap — MAX_RETRY_AFTER_MS).
        return json({ data: [] }, 200, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "10",
        });
      }),
    );
    await clioRequest(asDb(db), "user-1", "manage", "/matters.json");
    expect(dataCalls).toBe(1);
    // Next call is refused locally — no second request is issued.
    await expect(
      clioRequest(asDb(db), "user-1", "manage", "/matters.json"),
    ).rejects.toBeInstanceOf(ClioRateLimitError);
    expect(dataCalls).toBe(1);
  });

  it("waits out a within-cap reset then proceeds", async () => {
    const db = await seed("manage");
    let dataCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        dataCalls += 1;
        return dataCalls === 1
          ? json({ data: [] }, 200, {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "2",
            })
          : json({ data: [1] });
      }),
    );
    vi.useFakeTimers();
    try {
      await clioRequest(asDb(db), "user-1", "manage", "/matters.json");
      const p = clioRequest(asDb(db), "user-1", "manage", "/matters.json");
      await vi.advanceTimersByTimeAsync(2000);
      const body = (await p) as { data: unknown[] };
      expect(body.data).toHaveLength(1);
      expect(dataCalls).toBe(2);
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

// Added for the Practice Management surface: activity updates need If-Match, so
// clioRequest gained an additive `headers` option. It must never become a way to
// weaken the fixed auth/version headers.
describe("clioRequest — caller-supplied headers", () => {
  it("sends the extra header alongside the fixed ones", async () => {
    const db = await seed("manage");
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return json({ data: { id: 1 } });
      }),
    );

    await clioRequest(asDb(db), "user-1", "manage", "/activities/1.json", {
      method: "PATCH",
      headers: { "IF-MATCH": "etag-1" },
      json: { data: { note: "x" } },
    });

    const headers = calls[0].headers as Record<string, string>;
    expect(headers["IF-MATCH"]).toBe("etag-1");
    expect(headers.Authorization).toBe("Bearer access-1");
  });

  it("cannot override Authorization, Accept or the X-API-VERSION pin", async () => {
    const db = await seed("manage");
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return json({ data: [] });
      }),
    );

    await clioRequest(asDb(db), "user-1", "manage", "/matters.json", {
      headers: {
        Authorization: "Bearer attacker",
        Accept: "text/html",
        "X-API-VERSION": "1.0.0",
      },
    });

    const headers = calls[0].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-1");
    expect(headers.Accept).toBe("application/json");
    expect(headers["X-API-VERSION"]).not.toBe("1.0.0");
  });
});
