/**
 * Per-key rate limiter, shared by every web server and the worker.
 *
 * Fixed-window counter (not token bucket): every identifier gets a fresh
 * N-request budget each window. The count lives in auth_rate_limits (the
 * table the login limiter already uses, written by the bodhinox_auth role,
 * which every process has: rate limits run before auth for some callers).
 * One INSERT ... ON CONFLICT DO UPDATE ... RETURNING per check. Keys are
 * SHA-256 hashed together with the window length, so no raw IP, email or id
 * is stored. Expired rows are removed by the hourly clean-up
 * (src/lib/jobs/data-retention.ts).
 *
 * Failure mode: fail open to the per-process counter. If the database cannot
 * be reached, the check falls back to the in-memory window below, which is
 * exactly how every caller behaved before the counts moved to the database:
 * the request is still limited per process, never refused for a database error
 * and never let through unlimited.
 *
 * checkLocalRateLimit is the synchronous, per-process limiter. Only the
 * public shop page burst in src/proxy.ts uses it directly (a database write
 * per anonymous page view is not worth it; the per-IP burst is best effort).
 */

import { createHash } from 'node:crypto';
import { getAuthPrisma } from '@/lib/db/prisma';
import { NextResponse } from 'next/server';
import { getT } from '@/lib/i18n/translate';

const t = getT('LibErrors');

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

/** Per-process fixed window: the database fallback, and the proxy's page burst. */
export function checkLocalRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

/** The stored key: hashed, and namespaced away from the login limiter's keys. */
export function rateLimitStorageKey(key: string, windowMs: number): string {
  return createHash('sha256').update(`rate-limit:${windowMs}:${key}`).digest('hex');
}

let warnedFallback = false;

/**
 * One shared fixed-window count per key across every process. Falls back to
 * checkLocalRateLimit when the database is unavailable (see the file header).
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const { limit, windowMs } = options;
  try {
    const stored = rateLimitStorageKey(key, windowMs);
    const rows = await getAuthPrisma().$queryRaw<{ attempts: number; reset_ms: number }[]>`
      INSERT INTO auth_rate_limits(key,attempts,reset_at)
      VALUES(${stored},1,clock_timestamp()+${windowMs}*INTERVAL '1 millisecond')
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN auth_rate_limits.reset_at<=clock_timestamp() THEN 1
          ELSE LEAST(auth_rate_limits.attempts+1, ${limit + 1}) END,
        reset_at=CASE WHEN auth_rate_limits.reset_at<=clock_timestamp()
          THEN clock_timestamp()+${windowMs}*INTERVAL '1 millisecond' ELSE auth_rate_limits.reset_at END
      RETURNING attempts, (EXTRACT(EPOCH FROM reset_at)*1000)::float8 AS reset_ms`;
    const attempts = Number(rows[0]?.attempts);
    const reset = Math.round(Number(rows[0]?.reset_ms));
    if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(reset)) throw new Error('unreadable rate limit row');
    return {
      success: attempts <= limit,
      remaining: Math.max(0, limit - attempts),
      reset,
      limit,
    };
  } catch {
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn('[rate-limit] database unavailable; using the per-process limit');
    }
    return checkLocalRateLimit(key, options);
  }
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: t('rateLimitExceeded'),
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch budget. The legacy browser fan-out endpoint
   *  (`/api/whatsapp/broadcast`, batches of 10 recipients per call) has
   *  been removed: campaigns now go through `/api/broadcasts/create`,
   *  which queues one durable job and enforces the suspension check,
   *  the campaign_recipients plan limit and the 100k recipient cap.
   *  The bucket is kept at 60/min per user for any per-call broadcast
   *  action; Meta's own per-number limits remain the real throughput
   *  ceiling. */
  broadcast: { limit: 60, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Public booking pages (per IP, best effort: the leftmost forwarded
   *  address can be spoofed). The durable per-hour limits in the routes and
   *  the per-page cap on unconfirmed holds are the real backstops. */
  bookingSlots: { limit: 60, windowMs: 60_000 },
  bookingCreate: { limit: 10, windowMs: 60_000 },
  bookingManage: { limit: 30, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Campaign test sends (up to 3 real messages each), per user. */
  campaignTest: { limit: 10, windowMs: 60_000 },
  /** Flow API Request "Test request": each call reaches a third-party server. */
  flowTestRequest: { limit: 10, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Shared across every web server (database count). */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** AI draft-reply generation, per user. 20/min is generous for an
   *  agent clicking "Draft with AI" while working a thread, and bounds
   *  spend on the account's own LLM key against an accidental
   *  hold-down / script. */
  aiDraft: { limit: 20, windowMs: 60_000 },
  /** AI draft-reply generation, per account. Caps the WHOLE team's
   *  draws on the one shared BYO provider key — without this, N agents
   *  each under their per-user limit could still stampede the account's
   *  key past the provider's own rate limit. 60/min ≈ three busy agents
   *  drafting flat-out. */
  aiDraftAccount: { limit: 60, windowMs: 60_000 },
  /** AI auto-reply generation, per account. The per-conversation cap
   *  (`auto_reply_max_per_conversation`) bounds one thread; this bounds
   *  the whole account across threads, so a burst of inbound from many
   *  customers at once can't run the BYO key past the provider's limit
   *  or the owner's budget. 30/min is generous for organic inbound while
   *  capping a stampede; an excess inbound is retried by a delayed
   *  'ai.auto_reply_retry' job after the window (up to 5 times), then left
   *  in the inbox for a human. */
  aiAutoReplyAccount: { limit: 30, windowMs: 60_000 },
  /** AI assistant (summaries, suggested replies, assessments, insights), per
   *  member. A soft first line; the durable limit is the monthly
   *  token cap checked in the database before every provider call. */
  aiAssistUser: { limit: 20, windowMs: 60_000 },
  /** AI assistant, per workspace across all members. */
  aiAssistAccount: { limit: 60, windowMs: 60_000 },
  /** Token-protected deep health check (`/api/health?deep=1`), one shared
   *  bucket. Uptime monitors poll about once a minute; 30/min
   *  bounds the database work a leaked token can cause. */
  opsHealth: { limit: 30, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
  warnedFallback = false;
}
