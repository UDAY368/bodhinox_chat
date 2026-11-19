import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  campaignIntentKey, campaignJobKey, campaignText, EMAIL_LIMITS, emailRefusal, isEmailAddress, orderEmailIntentKey, orderEmailJobKey, parseCampaignInput,
  parseMarketingSettings, referralJobKey, sendSlot, UNSUBSCRIBE_TOKEN,
} from './email-rules';
import { readUnsubscribeToken, unsubscribeToken } from './email-send';
import { cleanLinkUrl, LINK_PAGE_LIMITS, parseLinkPage, readStoredLinks } from './link-page-rules';
import {
  attributionRefusal, holdDays, newReferralCode, parseReferralParam, referralCreditKey, REFERRAL_CODE, rewardDueAt, settleReferral, type SettleFacts,
} from './referral-rules';
import { parseAffiliate, parseCodePatch } from './referrals';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('email dedupe keys and schedule', () => {
  it('has one stable key per campaign recipient and per order, and each job key differs from its send key', () => {
    expect(campaignJobKey(A, B)).toBe(`emailc:${A}:${B}`);
    expect(campaignIntentKey(A, B)).toBe(`shop-email:${A}:${B}`);
    expect(campaignJobKey(A, B)).not.toBe(campaignJobKey(A, C));
    expect(campaignJobKey(A, B)).not.toBe(campaignJobKey(C, B));
    expect(orderEmailJobKey(A)).toBe(`oemail:${A}`);
    expect(orderEmailIntentKey(A)).toBe(`shop-order-email:${A}`);
    expect(referralJobKey(A)).toBe(`referral:${A}`);
    expect(referralCreditKey(A)).toBe(`referral:${A}`);
    expect(campaignJobKey(A, B).length).toBeLessThan(150);
  });

  it('spreads recipients over time at the fixed rate', () => {
    const start = new Date('2026-12-01T10:00:00Z');
    expect(sendSlot(start, 0).toISOString()).toBe('2026-12-01T10:00:00.000Z');
    expect(sendSlot(start, EMAIL_LIMITS.perMinute - 1).toISOString()).toBe('2026-12-01T10:00:00.000Z');
    expect(sendSlot(start, EMAIL_LIMITS.perMinute).toISOString()).toBe('2026-12-01T10:01:00.000Z');
    expect(sendSlot(start, EMAIL_LIMITS.recipients - 1).getTime() - start.getTime()).toBeLessThanOrEqual(167 * 60_000);
  });
});

describe('campaign and settings input', () => {
  const good = { name: 'Diwali', subject: 'Festive offers', body: 'Hello!\nSee our offers.', segment_id: A };

  it('accepts a campaign and trims it', () => {
    expect(parseCampaignInput({ ...good, name: '  Diwali  ' })).toEqual({ name: 'Diwali', subject: 'Festive offers', body: 'Hello!\nSee our offers.', segmentId: A });
    expect(parseCampaignInput({ ...good, segment_id: null }).segmentId).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['empty name', { name: '  ' }], ['subject with a line break (header injection)', { subject: 'Hi\r\nBcc: x@y.z' }], ['subject too long', { subject: 'x'.repeat(151) }],
    ['body too long', { body: 'x'.repeat(5001) }], ['body with a control character', { body: 'a\u0000b' }], ['segment that is not an id', { segment_id: 'nope' }],
  ])('refuses %s', (_label, patch) => {
    expect(() => parseCampaignInput({ ...good, ...patch })).toThrow();
  });

  const settings = { order_emails_enabled: true, sender_name: 'Asha Shop', sender_address: '12 Lake Road\nBengaluru 560001', reply_to: 'help@example.com', referral_enabled: true, referral_reward_minor: 5000, referral_hold_days: 14 };

  it('accepts settings, with optional text left out', () => {
    expect(parseMarketingSettings(settings)).toEqual(settings);
    expect(parseMarketingSettings({ ...settings, sender_name: '', sender_address: null, reply_to: undefined })).toMatchObject({ sender_name: null, sender_address: null, reply_to: null });
  });

  it.each<[string, Record<string, unknown>]>([
    ['reply-to that is not an address', { reply_to: 'not an address' }], ['sender name with a line break', { sender_name: 'A\nB' }],
    ['negative reward', { referral_reward_minor: -1 }], ['fractional reward', { referral_reward_minor: 1.5 }], ['hold over 90 days', { referral_hold_days: 91 }],
    ['switch that is not a boolean', { order_emails_enabled: 'yes' }],
  ])('refuses settings with %s', (_label, patch) => {
    expect(() => parseMarketingSettings({ ...settings, ...patch })).toThrow();
  });

  it('recognises plain email addresses only', () => {
    expect(isEmailAddress('asha@example.com')).toBe(true);
    for (const bad of ['asha', 'a@b c', 'a@b.com\nBcc: x@y', '"a"@b.com', 'a,b@c.com', '', null, 5]) expect(isEmailAddress(bad)).toBe(false);
  });
});

describe('who may be emailed (consent and unsubscribe)', () => {
  const contact = { email: 'asha@example.com', blocked_at: null };
  const yes = { opted_in_at: new Date('2026-11-01'), unsubscribed_at: null };

  it('needs an address and a recorded consent, and an unsubscribe wins over a consent', () => {
    expect(emailRefusal(contact, yes)).toBeNull();
    expect(emailRefusal(contact, null)).toBe('no_consent');
    expect(emailRefusal(contact, { opted_in_at: null, unsubscribed_at: null })).toBe('no_consent');
    expect(emailRefusal(contact, { ...yes, unsubscribed_at: new Date('2026-11-02') })).toBe('unsubscribed');
    expect(emailRefusal({ ...contact, email: null }, yes)).toBe('no_email');
    expect(emailRefusal({ ...contact, email: 'nope' }, yes)).toBe('no_email');
    expect(emailRefusal({ ...contact, blocked_at: new Date() }, yes)).toBe('contact_blocked');
  });

  it('puts the sender address and the unsubscribe link in every email', () => {
    const text = campaignText({ body: 'Offers inside', senderName: 'Asha Shop', senderAddress: '12 Lake Road', unsubscribeUrl: 'https://app.example/unsubscribe/shop?t=x', unsubscribeLine: 'Unsubscribe:' });
    expect(text).toContain('Offers inside');
    expect(text).toContain('12 Lake Road');
    expect(text).toContain('Unsubscribe: https://app.example/unsubscribe/shop?t=x');
  });
});

describe('unsubscribe tokens', () => {
  beforeEach(() => { vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64)); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('round-trips, and a changed or foreign token is refused', () => {
    const token = unsubscribeToken(A, B);
    expect(UNSUBSCRIBE_TOKEN.test(token)).toBe(true);
    expect(readUnsubscribeToken(token)).toEqual({ accountId: A, contactId: B });
    expect(readUnsubscribeToken(token.replace(B, C))).toBeNull();
    expect(readUnsubscribeToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(readUnsubscribeToken('x')).toBeNull();
    expect(readUnsubscribeToken(null)).toBeNull();
    vi.stubEnv('ENCRYPTION_KEY', 'b'.repeat(64));
    expect(readUnsubscribeToken(token)).toBeNull();
  });
});

describe('referral rules', () => {
  it('makes codes from the readable alphabet and reads a link value strictly', () => {
    for (let i = 0; i < 20; i++) expect(REFERRAL_CODE.test(newReferralCode())).toBe(true);
    expect(parseReferralParam(' abcd2345 ')).toBe('ABCD2345');
    for (const bad of ['ABCD234', 'ABCD23456', 'ABCD234O', 'ABCD-345', '', null, 7]) expect(parseReferralParam(bad)).toBeNull();
  });

  it('never attributes a buyer to their own code, by contact or by email, or to an inactive code', () => {
    const code = { active: true, kind: 'contact' as const, contactId: A, email: 'asha@example.com' };
    expect(attributionRefusal({ code, buyer: { contactId: B, email: 'ravi@example.com' } })).toBeNull();
    expect(attributionRefusal({ code, buyer: { contactId: A, email: null } })).toBe('self_referral');
    expect(attributionRefusal({ code, buyer: { contactId: B, email: ' ASHA@example.com ' } })).toBe('self_referral');
    expect(attributionRefusal({ code: { ...code, active: false }, buyer: { contactId: B, email: null } })).toBe('code_inactive');
    expect(attributionRefusal({ code: { active: true, kind: 'affiliate', contactId: null }, buyer: { contactId: B, email: null } })).toBeNull();
  });

  it('waits at least the return window after payment', () => {
    expect(holdDays(14, null)).toBe(14);
    expect(holdDays(14, 30)).toBe(30);
    expect(holdDays(0, 7)).toBe(7);
    expect(rewardDueAt(new Date('2026-12-01T00:00:00Z'), 14).toISOString()).toBe('2026-12-15T00:00:00.000Z');
  });

  const facts: SettleFacts = { kind: 'contact', orderStatus: 'paid', paid: true, totalMinor: 100_000, refundedMinor: 0, rewardMinor: 5000, commissionBps: null, hasReferrer: true };

  it('settles a customer reward once the order stands, and nothing when it was cancelled, refunded or unpaid', () => {
    expect(settleReferral(facts)).toEqual({ status: 'rewarded', netMinor: 100_000, rewardMinor: 5000, commissionMinor: 0 });
    expect(settleReferral({ ...facts, refundedMinor: 40_000 })).toMatchObject({ status: 'rewarded', netMinor: 60_000 });
    expect(settleReferral({ ...facts, refundedMinor: 100_000 })).toEqual({ status: 'skipped', reason: 'refunded' });
    expect(settleReferral({ ...facts, orderStatus: 'cancelled' })).toEqual({ status: 'skipped', reason: 'order_cancelled' });
    expect(settleReferral({ ...facts, paid: false })).toEqual({ status: 'skipped', reason: 'not_paid' });
    expect(settleReferral({ ...facts, hasReferrer: false })).toEqual({ status: 'skipped', reason: 'referrer_gone' });
    expect(settleReferral({ ...facts, rewardMinor: 0 })).toEqual({ status: 'skipped', reason: 'no_reward' });
  });

  it('works out an affiliate commission on the net amount, rounded down, with no credit', () => {
    expect(settleReferral({ ...facts, kind: 'affiliate', commissionBps: 1000, hasReferrer: false, refundedMinor: 10_001 }))
      .toEqual({ status: 'rewarded', netMinor: 89_999, rewardMinor: 0, commissionMinor: 8999 });
  });

  it('validates affiliates and code changes', () => {
    expect(parseAffiliate({ name: ' Priya ', commission_bps: 1000 })).toEqual({ name: 'Priya', commissionBps: 1000 });
    for (const bad of [{ name: '', commission_bps: 10 }, { name: 'x', commission_bps: 5001 }, { name: 'x', commission_bps: 1.5 }, { name: 'a\nb', commission_bps: 1 }, null])
      expect(() => parseAffiliate(bad)).toThrow();
    expect(parseCodePatch({ active: false })).toEqual({ active: false });
    expect(() => parseCodePatch({})).toThrow();
    expect(() => parseCodePatch({ active: 'no' })).toThrow();
  });
});

describe('link page', () => {
  it('accepts only plain http and https addresses', () => {
    expect(cleanLinkUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(cleanLinkUrl('  http://example.com  ')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', '//example.com', '/relative', 'https://user:pass@example.com', 'https://exa mple.com', 'mailto:a@b.c', 'https://', '', null, 4, `https://example.com/${'a'.repeat(500)}`])
      expect(cleanLinkUrl(bad)).toBeNull();
  });

  const page = { enabled: true, bio: 'Handmade soaps', links: [{ label: 'Instagram', url: 'https://instagram.com/x' }], featured_product_ids: [A, A.toUpperCase(), B] };

  it('saves a page, keeping featured products distinct', () => {
    expect(parseLinkPage(page)).toEqual({ enabled: true, bio: 'Handmade soaps', links: [{ label: 'Instagram', url: 'https://instagram.com/x' }], featuredProductIds: [A, B] });
    expect(parseLinkPage({ ...page, bio: '' }).bio).toBeNull();
  });

  it('caps the links, the bio and the featured products, and refuses a bad link', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
    expect(parseLinkPage({ ...page, links: many(LINK_PAGE_LIMITS.links) }).links).toHaveLength(12);
    expect(() => parseLinkPage({ ...page, links: many(13) })).toThrow();
    expect(() => parseLinkPage({ ...page, bio: 'x'.repeat(281) })).toThrow();
    expect(() => parseLinkPage({ ...page, featured_product_ids: [A, B, C, ...Array.from({ length: 4 }, (_, i) => `4444444${i}-4444-4444-8444-444444444444`)] })).toThrow();
    expect(() => parseLinkPage({ ...page, links: [{ label: 'x', url: 'javascript:alert(1)' }] })).toThrow();
    expect(() => parseLinkPage({ ...page, links: [{ label: '', url: 'https://example.com' }] })).toThrow();
    expect(() => parseLinkPage({ ...page, featured_product_ids: ['nope'] })).toThrow();
  });

  it('drops a stored link that no longer passes instead of showing it', () => {
    expect(readStoredLinks([{ label: 'ok', url: 'https://example.com' }, { label: 'bad', url: 'javascript:1' }, { label: '', url: 'https://example.com' }, 7, null]))
      .toEqual([{ label: 'ok', url: 'https://example.com/' }]);
    expect(readStoredLinks('x')).toEqual([]);
  });
});
