import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LandRegistryError,
  MAX_RESULTS,
  getPricePaidByPostcode,
  normalizePostcode,
  resetLandRegistryStateForTests,
} from "./landRegistry";

const COMMON = "http://landregistry.data.gov.uk/def/common";

/** Builds a SPARQL-results binding from plain string fields. */
function bindingOf(fields: Record<string, string | undefined>) {
  const out: Record<string, { type: string; value: string }> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = { type: "literal", value };
  }
  return out;
}

function sparqlResponse(
  bindings: Array<Record<string, { type: string; value: string }>>,
  status = 200,
): Response {
  return new Response(
    JSON.stringify({ head: { vars: [] }, results: { bindings } }),
    { status, headers: { "content-type": "application/sparql-results+json" } },
  );
}

afterEach(() => {
  resetLandRegistryStateForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("normalizePostcode", () => {
  const valid: [string, string][] = [
    ["pl6 8ru", "PL6 8RU"],
    ["IG101LH", "IG10 1LH"],
    ["  sw1a  1aa ", "SW1A 1AA"],
    ["ec1a1bb", "EC1A 1BB"],
    ["m11ae", "M1 1AE"],
    ["b338th", "B33 8TH"],
  ];
  it.each(valid)("normalises %s → %s", (input, expected) => {
    expect(normalizePostcode(input)).toBe(expected);
  });

  const invalid = [
    "",
    "   ",
    "ABC",
    "12345",
    "PL6 8R",
    "ZZ1",
    "PL6-8RU",
    "!!!",
  ];
  it.each(invalid)("rejects %s", (input) => {
    expect(normalizePostcode(input)).toBeNull();
  });
});

describe("getPricePaidByPostcode", () => {
  it("rejects an invalid postcode with a 400 LandRegistryError, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getPricePaidByPostcode("not-a-postcode"),
    ).rejects.toMatchObject({ name: "LandRegistryError", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only ever embeds the validated, normalised postcode in the query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sparqlResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await getPricePaidByPostcode("  pl6 8ru ");

    const [url, init] = fetchMock.mock.calls[0];
    const query = new URL(String(url)).searchParams.get("query") ?? "";
    expect(query).toContain('"PL6 8RU"^^xsd:string');
    expect((init as RequestInit).headers).toMatchObject({
      Accept: "application/sparql-results+json",
    });
  });

  it("normalises a happy-path binding into the {address, propertyType, tenure, price, date} shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sparqlResponse([
        bindingOf({
          saon: "FLAT 3",
          paon: "130",
          street: "CHURCH HILL",
          town: "LOUGHTON",
          amount: "328000",
          date: "2025-09-19",
          propertyType: `${COMMON}/flat-maisonette`,
          estateType: `${COMMON}/leasehold`,
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const entries = await getPricePaidByPostcode("IG10 1LH");
    expect(entries).toEqual([
      {
        address: "Flat 3, 130 Church Hill, Loughton",
        propertyType: "Flat",
        tenure: "Leasehold",
        price: 328000,
        date: "2025-09-19",
      },
    ]);
  });

  it("maps property/estate type URIs and tolerates missing optional fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sparqlResponse([
        bindingOf({
          paon: "104",
          street: "PATTINSON DRIVE",
          town: "PLYMOUTH",
          amount: "217750",
          date: "2025-06-30",
          propertyType: `${COMMON}/semi-detached`,
          estateType: `${COMMON}/freehold`,
        }),
        // No property/estate type, no saon → null type/tenure, no leading comma.
        bindingOf({
          paon: "12",
          street: "HIGH STREET",
          town: "PLYMOUTH",
          amount: "150000",
          date: "2024-01-02",
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const entries = await getPricePaidByPostcode("PL6 8RU");
    expect(entries[0]).toMatchObject({
      address: "104 Pattinson Drive, Plymouth",
      propertyType: "Semi-detached",
      tenure: "Freehold",
    });
    expect(entries[1]).toMatchObject({
      address: "12 High Street, Plymouth",
      propertyType: null,
      tenure: null,
    });
  });

  it("caps results at the 25 most recent and sorts newest-first", async () => {
    // 30 bindings with ascending dates, delivered in ascending order so the
    // newest-first sort and the cap are both exercised.
    const bindings = Array.from({ length: 30 }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      return bindingOf({
        paon: String(i + 1),
        street: "TEST ROAD",
        town: "TESTVILLE",
        amount: String(100000 + i),
        date: `2025-01-${day}`,
        estateType: `${COMMON}/freehold`,
      });
    });
    const fetchMock = vi.fn().mockResolvedValue(sparqlResponse(bindings));
    vi.stubGlobal("fetch", fetchMock);

    const entries = await getPricePaidByPostcode("PL6 8RU");
    expect(entries).toHaveLength(MAX_RESULTS);
    expect(entries[0].date).toBe("2025-01-30");
    expect(entries[entries.length - 1].date).toBe("2025-01-06");
  });

  it("caches by postcode: a repeat lookup does not hit the network again", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sparqlResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await getPricePaidByPostcode("PL6 8RU");
    await getPricePaidByPostcode("pl6 8ru");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns an upstream non-2xx into a LandRegistryError (never raw upstream text)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sparqlResponse([], 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPricePaidByPostcode("PL6 8RU")).rejects.toBeInstanceOf(
      LandRegistryError,
    );
  });

  it("turns a network failure into a LandRegistryError", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPricePaidByPostcode("PL6 8RU")).rejects.toMatchObject({
      name: "LandRegistryError",
    });
  });

  it("aborts and errors when the upstream fetch exceeds the 10s timeout", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its abort signal fires.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = getPricePaidByPostcode("PL6 8RU");
    const assertion = expect(promise).rejects.toBeInstanceOf(LandRegistryError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
