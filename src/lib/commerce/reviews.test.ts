import { describe, expect, it } from 'vitest';
import { agentHoldRefusal } from './order-followup';
import {
  cleanReviewBody, isShopCommand, isSkipText, parseRatingText, parseReviewReplyId, queueReviewRequestTx, ratingSummary,
  REVIEW_REQUEST_DELAY_MS, reviewerInitial, reviewReplyId,
} from './reviews';

const ORDER = '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b';
const PRODUCT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('review reply ids (store plan Phase 3)', () => {
  it('round-trips the order, product and stars of a star row', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(parseReviewReplyId(reviewReplyId(ORDER, PRODUCT, n))).toEqual({ orderId: ORDER, productId: PRODUCT, rating: n });
    expect(reviewReplyId(ORDER, PRODUCT, 5).length).toBeLessThanOrEqual(100);
  });
  it('is case-insensitive for the ids and lower-cases them', () => {
    expect(parseReviewReplyId(`rvw:${ORDER.toUpperCase()}:${PRODUCT}:4`)).toEqual({ orderId: ORDER, productId: PRODUCT, rating: 4 });
  });
  it('refuses every other id', () => {
    for (const bad of [null, undefined, 42, '', 'rvw', `rvw:${ORDER}:${PRODUCT}`, `rvw:${ORDER}:${PRODUCT}:0`, `rvw:${ORDER}:${PRODUCT}:6`,
      `rvw:${ORDER}:${PRODUCT}:10`, `rvw:${ORDER}:${PRODUCT}:5 `, `rvw:${ORDER}:not-a-uuid:5`, `codc:${ORDER}:yes`, `xrvw:${ORDER}:${PRODUCT}:5`,
      `rvw:${ORDER}:${PRODUCT}:5:extra`, `${'x'.repeat(200)}`])
      expect(parseReviewReplyId(bad)).toBeNull();
  });
});

describe('review text rules', () => {
  it('accepts only a lone digit 1 to 5 as a rating', () => {
    expect(parseRatingText('5')).toBe(5);
    expect(parseRatingText(' 3 ')).toBe(3);
    for (const bad of ['0', '6', '10', '5 stars', 'four', '', null, undefined, '4.5']) expect(parseRatingText(bad)).toBeNull();
  });
  it('treats shop commands and STOP as commands, but not ordinary sentences', () => {
    for (const cmd of ['ORDER ABC234', 'order', 'Notify me', 'STOP', 'stop', 'start', 'BOOK 123', 'unsubscribe']) expect(isShopCommand(cmd)).toBe(true);
    for (const text of ['Great oil, my hair feels softer', 'I ordered twice', 'stopped working', 'Starting to love it']) expect(isShopCommand(text)).toBe(false);
  });
  it('knows a skip', () => {
    for (const t of ['skip', 'Skip.', ' SKIP ', 'saltar', 'pular', '건너뛰기']) expect(isSkipText(t)).toBe(true);
    expect(isSkipText('skip the queue next time')).toBe(false);
  });
  it('cleans the review body: control characters out, spaces collapsed, at most 1000 characters', () => {
    expect(cleanReviewBody('  Lovely\u0000 scent\n\nand\tsoft  ')).toBe('Lovely scent and soft');
    expect(cleanReviewBody('a\u202Eb\u2028c')).toBe('a b c');
    expect(cleanReviewBody('x'.repeat(1500))).toHaveLength(1000);
    expect(Array.from(cleanReviewBody('😀'.repeat(1200))!)).toHaveLength(1000);
    for (const empty of ['', '  \n\t ', '\u0000\u0007', null, undefined]) expect(cleanReviewBody(empty)).toBeNull();
  });
  it('shows only the first letter of the name', () => {
    expect(reviewerInitial('Ravi Kumar')).toBe('R.');
    expect(reviewerInitial('  éva')).toBe('É.');
    expect(reviewerInitial('प्रिया')).toBe('प.');
    for (const none of ['+919800000000', '👍 Sam', '', '   ', null, undefined]) expect(reviewerInitial(none)).toBeNull();
  });
});

describe('rating aggregation', () => {
  it('is null without ratings and rounds the average to one decimal', () => {
    expect(ratingSummary([])).toBeNull();
    expect(ratingSummary([5])).toEqual({ average: 5, count: 1 });
    expect(ratingSummary([5, 4])).toEqual({ average: 4.5, count: 2 });
    expect(ratingSummary([5, 4, 4])).toEqual({ average: 4.3, count: 3 });
    expect(ratingSummary([1, 2, 2, 5, 5, 5])).toEqual({ average: 3.3, count: 6 });
  });
});

describe('review request rules', () => {
  it('is held back by an agent takeover like the other marketing messages', () => {
    expect(agentHoldRefusal('review_request', true)).toBe('bot_paused');
    expect(agentHoldRefusal('review_request', false)).toBeNull();
    expect(agentHoldRefusal('delivered', true)).toBeNull();
  });
  it('queues one job three days later, only when the store setting is on', async () => {
    const calls: unknown[][] = [];
    const tx = (enabled: boolean | null) => ({
      $queryRaw: async () => (enabled === null ? [] : [{ enabled }]),
      $executeRaw: async (...args: unknown[]) => { calls.push(args); return 1; },
    });
    const now = new Date('2026-11-20T10:00:00Z');
    expect(await queueReviewRequestTx(tx(false) as never, 'a', ORDER, now)).toBe(false);
    expect(await queueReviewRequestTx(tx(null) as never, 'a', ORDER, now)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await queueReviewRequestTx(tx(true) as never, 'a', ORDER, now)).toBe(true);
    expect(calls).toHaveLength(1);
    const values = calls[0].slice(1);
    expect(values).toContain(`review:${ORDER}`);
    expect(values).toContainEqual(new Date(now.getTime() + REVIEW_REQUEST_DELAY_MS));
    expect(REVIEW_REQUEST_DELAY_MS).toBe(3 * 86_400_000);
  });
});
