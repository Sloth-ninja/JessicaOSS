// Generic in-process concurrency helpers.
//
// These are deliberately provider-agnostic: `companiesHouse.ts` (WS1)
// instantiates its own TokenBucket/SingleFlight state, and any other
// integration (e.g. WS2's legislation.gov.uk politeness limiter) must
// instantiate its own too — do NOT share instances across integrations.

/**
 * A continuous-refill token bucket. `capacity` tokens are available per
 * `refillIntervalMs`; tokens refill smoothly (proportional to elapsed time)
 * rather than in discrete steps, so short bursts spread out naturally.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const refillAmount = (elapsed / this.refillIntervalMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.lastRefill = now;
  }

  /**
   * Attempts to consume one token. Returns true and consumes a token if one
   * was available, false (no consumption) otherwise.
   */
  tryRemoveToken(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Whole tokens currently available (after refilling). */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/**
 * De-duplicates concurrent async calls that share the same key: the first
 * caller's promise is shared with any other caller for the same key while
 * it is in flight; once it settles, the next call for that key runs fresh.
 */
export class SingleFlight<T = unknown> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
