// Phase 11 T2: comment-rule validation and the guards that run before any database work.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: db.withTenant }));

import {
  createCommentRule, deleteCommentRule, listCommentRules, MAX_KEYWORDS, normaliseKeywords, normaliseRule, updateCommentRule,
} from './comment-rules';
import { InstagramError } from './errors';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const IG = '44444444-4444-4444-8444-444444444444';
const RULE = '55555555-5555-4555-8555-555555555555';
const admin = { accountId: ACCOUNT, userId: '22222222-2222-4222-8222-222222222222', role: 'admin' as const };
const rule = { mediaId: null, keywords: ['price'], replyText: 'Hi! Here is the price list.', active: true };
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const codeOfSync = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return e instanceof InstagramError ? e.code : String(e); } };

beforeEach(() => db.withTenant.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('normalise', () => {
  it('lower-cases, trims, collapses spaces and de-duplicates keywords', () => {
    expect(normaliseKeywords([' Price ', 'PRICE', 'how  much', '', '  '])).toEqual(['price', 'how much']);
  });

  it('refuses too many or over-long keywords', () => {
    expect(codeOfSync(() => normaliseKeywords(Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `k${i}`)))).toBe('invalid_request');
    expect(codeOfSync(() => normaliseKeywords(['x'.repeat(51)]))).toBe('invalid_request');
    expect(normaliseKeywords(['x'.repeat(50)])).toHaveLength(1);
  });

  it('checks the reply in UTF-8 bytes and the post id as digits', () => {
    expect(normaliseRule({ ...rule, replyText: '  hi  ', mediaId: ' 1789 ' })).toMatchObject({ replyText: 'hi', mediaId: '1789' });
    expect(normaliseRule({ ...rule, mediaId: '' }).mediaId).toBeNull();
    expect(codeOfSync(() => normaliseRule({ ...rule, replyText: '   ' }))).toBe('invalid_request');
    expect(codeOfSync(() => normaliseRule({ ...rule, replyText: 'é'.repeat(501) }))).toBe('invalid_request');
    expect(normaliseRule({ ...rule, replyText: 'é'.repeat(500) }).replyText).toHaveLength(500);
    expect(codeOfSync(() => normaliseRule({ ...rule, mediaId: '12a' }))).toBe('invalid_request');
  });
});

describe('guards', () => {
  it('refuse everything while Instagram is off, before any database work', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    expect(await codeOf(listCommentRules(admin, IG))).toBe('instagram_not_enabled');
    expect(await codeOf(createCommentRule(admin, IG, rule))).toBe('instagram_not_enabled');
    expect(await codeOf(updateCommentRule(admin, IG, RULE, { active: false }))).toBe('instagram_not_enabled');
    expect(await codeOf(deleteCommentRule(admin, IG, RULE))).toBe('instagram_not_enabled');
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('refuse non-admins and malformed ids when enabled', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', 'true');
    vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
    vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
    vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
    vi.stubEnv('APP_URL', 'https://app.example.test');
    expect(await codeOf(createCommentRule({ ...admin, role: 'agent' }, IG, rule))).toBe('forbidden');
    expect(await codeOf(listCommentRules({ ...admin, role: 'viewer' as const }, IG))).toBe('forbidden');
    expect(await codeOf(updateCommentRule(admin, IG, 'nope', { active: false }))).toBe('not_found');
    expect(await codeOf(deleteCommentRule(admin, 'nope', RULE))).toBe('not_found');
    expect(await codeOf(createCommentRule(admin, IG, { ...rule, replyText: '' }))).toBe('invalid_request');
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});
