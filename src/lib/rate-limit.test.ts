import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ getAuthPrisma: () => ({ $queryRaw: db.queryRaw }) }));

import {
  __resetRateLimitForTests,
  checkLocalRateLimit,
  checkRateLimit,
  rateLimitResponse,
  rateLimitStorageKey,
} from "./rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit (shared database count)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reads the shared count and stores only a hash of the key", async () => {
    const reset = Date.now() + 42_000;
    db.queryRaw.mockResolvedValueOnce([{ attempts: 4, reset_ms: reset }]);
    expect(await checkRateLimit("ip:203.0.113.9", OPTS)).toEqual({ success: false, remaining: 0, reset, limit: 3 });
    const values = db.queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(rateLimitStorageKey("ip:203.0.113.9", 60_000));
    expect(values.join(" ")).not.toContain("203.0.113.9");
    expect(rateLimitStorageKey("k", 60_000)).not.toBe(rateLimitStorageKey("k", 1_000));
  });

  it("fails open to the per-process limit when the database is unavailable", async () => {
    db.queryRaw.mockRejectedValue(new Error("connection refused"));
    for (let i = 0; i < 3; i++) expect((await checkRateLimit("user:9", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:9", OPTS)).success).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).not.toContain("user:9");
  });
});

describe("checkLocalRateLimit (per-process fallback)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it("permits the first request and decrements remaining", () => {
    const result = checkLocalRateLimit("user:1", OPTS);
    expect(result).toMatchObject({
      success: true,
      remaining: 2,
      limit: 3,
    });
    expect(result.reset).toBeGreaterThan(Date.now());
  });

  it("permits exactly `limit` requests then rejects the next", () => {
    expect(checkLocalRateLimit("user:1", OPTS).success).toBe(true);
    expect(checkLocalRateLimit("user:1", OPTS).success).toBe(true);
    expect(checkLocalRateLimit("user:1", OPTS).success).toBe(true);
    const over = checkLocalRateLimit("user:1", OPTS);
    expect(over.success).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("keeps separate counters per key", () => {
    checkLocalRateLimit("user:1", OPTS);
    checkLocalRateLimit("user:1", OPTS);
    checkLocalRateLimit("user:1", OPTS);
    // user:1 is at the cap, user:2 should still be unaffected.
    const other = checkLocalRateLimit("user:2", OPTS);
    expect(other.success).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("opens a fresh window after `windowMs` elapses", () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-05-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      __resetRateLimitForTests();

      checkLocalRateLimit("user:1", OPTS);
      checkLocalRateLimit("user:1", OPTS);
      checkLocalRateLimit("user:1", OPTS);
      expect(checkLocalRateLimit("user:1", OPTS).success).toBe(false);

      // Jump just past the window.
      vi.setSystemTime(t0 + OPTS.windowMs + 1);
      const refreshed = checkLocalRateLimit("user:1", OPTS);
      expect(refreshed.success).toBe(true);
      expect(refreshed.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with retry / X-RateLimit headers", async () => {
    const reset = Date.now() + 30_000;
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset,
      limit: 60,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit/i);
  });

  it("clamps Retry-After to a minimum of 1 second", () => {
    // Reset already in the past — the ceiling math would otherwise give 0.
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset: Date.now() - 5_000,
      limit: 10,
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

describe("RATE_LIMITS presets", () => {
  it("send and broadcast are budgeted per minute", async () => {
    __resetRateLimitForTests();
    // Importing here so the presets stay close to their assertions.
    const { RATE_LIMITS } = await import("./rate-limit");
    expect(RATE_LIMITS.send.windowMs).toBe(60_000);
    expect(RATE_LIMITS.broadcast.windowMs).toBe(60_000);
  });

  it("the broadcast budget carries a campaign's per-batch call pattern", async () => {
    __resetRateLimitForTests();
    const { RATE_LIMITS } = await import("./rate-limit");
    // A campaign is NOT one call: the wizard posts a batch of 10
    // recipients roughly every 1–2 s, so it needs ~45+ calls of headroom
    // per minute. Sized below that, every batch past the cap comes back
    // 429 and its recipients are written off as failed (issue #472).
    expect(RATE_LIMITS.broadcast.limit).toBeGreaterThanOrEqual(45);
  });
});

afterEach(() => {
  __resetRateLimitForTests();
});
