import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIO_GROW_SCOPES,
  clioCallbackPath,
  clioConfigured,
  clioCredentials,
  clioHosts,
  clioManageApiVersion,
  clioRedirectUri,
  clioRegion,
} from "./config";

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.CLIO_REGION;
  delete process.env.CLIO_CLIENT_ID;
  delete process.env.CLIO_CLIENT_SECRET;
  delete process.env.CLIO_GROW_CLIENT_ID;
  delete process.env.CLIO_GROW_CLIENT_SECRET;
  delete process.env.CLIO_MANAGE_API_VERSION;
  delete process.env.API_PUBLIC_URL;
  delete process.env.BACKEND_URL;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("clioRegion", () => {
  it("defaults to eu", () => {
    expect(clioRegion()).toBe("eu");
  });
  it("falls back to eu on an unrecognised value rather than throwing", () => {
    process.env.CLIO_REGION = "mars";
    expect(clioRegion()).toBe("eu");
  });
  it("honours a recognised region", () => {
    process.env.CLIO_REGION = "us";
    expect(clioRegion()).toBe("us");
  });
});

describe("clioHosts (EU — verified live)", () => {
  it("maps Manage to the eu.app.clio.com endpoints", () => {
    const h = clioHosts("manage", "eu");
    expect(h.authorizeUrl).toBe("https://eu.app.clio.com/oauth/authorize");
    expect(h.tokenUrl).toBe("https://eu.app.clio.com/oauth/token");
    expect(h.revokeUrl).toBe("https://eu.app.clio.com/oauth/deauthorize");
    expect(h.apiBase).toBe("https://eu.app.clio.com/api/v4");
  });
  it("maps Grow to the eu.auth.api / eu.api hosts", () => {
    const h = clioHosts("grow", "eu");
    expect(h.authorizeUrl).toBe("https://eu.auth.api.clio.com/oauth/authorize");
    expect(h.tokenUrl).toBe("https://eu.auth.api.clio.com/oauth/token");
    expect(h.revokeUrl).toBe("https://eu.auth.api.clio.com/oauth/revoke");
    expect(h.apiBase).toBe("https://eu.api.clio.com/grow");
  });
  it("maps the US region without a prefix", () => {
    expect(clioHosts("manage", "us").apiBase).toBe(
      "https://app.clio.com/api/v4",
    );
  });
});

describe("CLIO_GROW_SCOPES", () => {
  it("is the space-separated verified scope set", () => {
    expect(CLIO_GROW_SCOPES).toBe(
      "grow_lead_inbox_read grow_custom_action_read grow_matter_read grow_matter_note_read grow_contact_read grow_contact_note_read grow_user_read",
    );
  });
});

describe("clioManageApiVersion", () => {
  it("defaults to the pinned v4 major", () => {
    expect(clioManageApiVersion()).toBe("4.0.11");
  });
  it("is env-overridable", () => {
    process.env.CLIO_MANAGE_API_VERSION = "4.0.99";
    expect(clioManageApiVersion()).toBe("4.0.99");
  });
});

describe("clioCredentials / clioConfigured", () => {
  it("is null when unconfigured", () => {
    expect(clioCredentials("manage")).toBeNull();
    expect(clioConfigured("manage")).toBe(false);
  });
  it("reads Manage vs Grow from distinct env vars", () => {
    process.env.CLIO_CLIENT_ID = "m-id";
    process.env.CLIO_CLIENT_SECRET = "m-secret";
    process.env.CLIO_GROW_CLIENT_ID = "g-id";
    process.env.CLIO_GROW_CLIENT_SECRET = "g-secret";
    expect(clioCredentials("manage")).toEqual({
      clientId: "m-id",
      clientSecret: "m-secret",
    });
    expect(clioCredentials("grow")).toEqual({
      clientId: "g-id",
      clientSecret: "g-secret",
    });
    expect(clioConfigured("grow")).toBe(true);
  });
});

describe("redirect URIs", () => {
  it("uses the exact registered callback paths per product", () => {
    expect(clioCallbackPath("manage")).toBe("/clio/oauth/callback");
    expect(clioCallbackPath("grow")).toBe("/clio-grow/oauth/callback");
  });
  it("derives the redirect URI from API_PUBLIC_URL", () => {
    process.env.API_PUBLIC_URL = "https://api.jessicaoss.com";
    expect(clioRedirectUri("manage")).toBe(
      "https://api.jessicaoss.com/clio/oauth/callback",
    );
    expect(clioRedirectUri("grow")).toBe(
      "https://api.jessicaoss.com/clio-grow/oauth/callback",
    );
  });
  it("defaults to the registered 127.0.0.1 literal (localhost banned)", () => {
    expect(clioRedirectUri("manage")).toBe(
      "http://127.0.0.1:3001/clio/oauth/callback",
    );
  });
});
