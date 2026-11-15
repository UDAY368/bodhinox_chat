/**
 * Store plan Phase 3, package 4: the pure rules and the queueing for product
 * reviews asked on WhatsApp after delivery. No provider calls and no heavy
 * imports, so order-lifecycle.ts can queue the request without a cycle (the job
 * and the inbound replies are in review-jobs.ts, the database reads in
 * review-data.ts).
 *
 * Flow: three days after an order is delivered (store setting on) one
 * commerce.review_request job asks about the order's highest-value product: a list
 * of five star rows inside the customer window (row id rvw:<order>:<product>:<1-5>),
 * else an approved MARKETING template that asks the buyer to reply with 1 to 5.
 * The rating is stored 'pending'; the buyer's next plain message within 30 minutes
 * becomes the text; an admin publishes or hides it.
 */
import type { TenantTransaction } from '@/lib/db/tenant';

export const REVIEW_REQUEST_JOB = 'commerce.review_request';
/** The request goes out three days after delivery. */
export const REVIEW_REQUEST_DELAY_MS = 3 * 86_400_000;
/** A typed 1 to 5 counts for seven days after a template request. */
export const REVIEW_TEXT_REPLY_DAYS = 7;
/** The words after a rating are taken for 30 minutes. */
export const REVIEW_BODY_WINDOW_MS = 30 * 60_000;
export const REVIEW_BODY_MAX = 1000;
/** Published reviews one product page lists. */
export const PUBLIC_REVIEW_LIMIT = 10;

export const REVIEW_STATUSES = ['pending', 'published', 'hidden'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const isReviewStatus = (value: unknown): value is ReviewStatus =>
  typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const REVIEW_REPLY = new RegExp(`^rvw:(${UUID}):(${UUID}):([1-5])$`, 'i');

export const reviewReplyId = (orderId: string, productId: string, rating: number) => `rvw:${orderId}:${productId}:${rating}`;

/** The order, product and stars of a star-row id, or null for any other reply id. */
export function parseReviewReplyId(replyId: unknown): { orderId: string; productId: string; rating: number } | null {
  if (typeof replyId !== 'string' || replyId.length > 100) return null;
  const match = REVIEW_REPLY.exec(replyId);
  return match ? { orderId: match[1].toLowerCase(), productId: match[2].toLowerCase(), rating: Number(match[3]) } : null;
}

/** A message that is only a digit 1 to 5 (the answer to a template request), else null. */
export function parseRatingText(text: string | null | undefined): number | null {
  if (typeof text !== 'string' || text.length > 20) return null;
  const match = /^\s*([1-5])\s*$/.exec(text);
  return match ? Number(match[1]) : null;
}

/** A shop command the buyer typed: it is never taken as review text. */
export function isShopCommand(text: string): boolean {
  return /^\s*(order|notify|book|stop|start|unsubscribe|subscribe|help)\b/i.test(text);
}

/** The buyer declining to add words ("skip"): it closes the chance without storing anything. */
export function isSkipText(text: string): boolean {
  return /^\s*(skip|saltar|pular|건너뛰기)\s*[.!]?\s*$/iu.test(text);
}

/** The review text: control characters removed, spaces collapsed, at most 1000 characters; null when nothing is left. */
export function cleanReviewBody(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? Array.from(cleaned).slice(0, REVIEW_BODY_MAX).join('') : null;
}

/** "R." from the first letter of a contact's name; null when the name does not start with a letter. */
export function reviewerInitial(name: string | null | undefined): string | null {
  const first = typeof name === 'string' ? Array.from(name.trim())[0] : undefined;
  return first && /^\p{L}$/u.test(first) ? `${first.toUpperCase()}.` : null;
}

export interface RatingSummary { average: number; count: number }

/** The average of published ratings to one decimal, or null when there are none. */
export function ratingSummary(ratings: readonly number[]): RatingSummary | null {
  if (!ratings.length) return null;
  const sum = ratings.reduce((a, b) => a + b, 0);
  return { average: Math.round((sum / ratings.length) * 10) / 10, count: ratings.length };
}

/**
 * Queue the one review request for an order that was just delivered, when the
 * store has the setting on. Same transaction as the delivery; the dedupe key
 * makes a repeat a no-op. The job checks the setting again when it runs.
 */
export async function queueReviewRequestTx(tx: TenantTransaction, accountId: string, orderId: string, now = new Date()): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ enabled: boolean }[]>`
    SELECT review_requests_enabled AS enabled FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  if (!row?.enabled) return false;
  const runAt = new Date(now.getTime() + REVIEW_REQUEST_DELAY_MS);
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${REVIEW_REQUEST_JOB},${accountId}::uuid,${JSON.stringify({ orderId })}::jsonb,${`review:${orderId}`},${runAt})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return true;
}
