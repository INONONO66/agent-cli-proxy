export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const BUCKET_SWEEP_INTERVAL_MS = 60_000;
const BUCKET_IDLE_TTL_MS = 10 * 60_000;

export class PerClientRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private nextSweepAt = 0;

  constructor(
    readonly limitPerMinute: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.capacity = Math.max(0, limitPerMinute);
    this.refillPerMs = this.capacity / 60_000;
  }

  take(tool: string, clientId: string): RateLimitDecision {
    if (this.capacity <= 0) return { allowed: true, retryAfterSeconds: 0 };

    const now = this.nowMs();
    this.sweep(now);
    const key = `${tool}\u0000${clientId}`;
    const bucket = this.refill(key, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    RateLimitMetrics.increment();
    const missing = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(missing / this.refillPerMs);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  private refill(key: string, now: number): Bucket {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      const created = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, created);
      return created;
    }

    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    return bucket;
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + BUCKET_SWEEP_INTERVAL_MS;
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      const tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      if (tokens >= this.capacity && elapsed >= BUCKET_IDLE_TTL_MS) {
        this.buckets.delete(key);
      }
    }
  }
}

export namespace RateLimitMetrics {
  let limitedTotal = 0;

  export function increment(): void {
    limitedTotal += 1;
  }

  export function renderPrometheus(): string {
    return [
      "# HELP agent_cli_proxy_rate_limited_total Total proxied requests rejected by per-client rate limiting",
      "# TYPE agent_cli_proxy_rate_limited_total counter",
      `agent_cli_proxy_rate_limited_total ${limitedTotal}`,
    ].join("\n");
  }

  export function __resetForTests(): void {
    limitedTotal = 0;
  }
}
