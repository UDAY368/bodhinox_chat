import { describe, expect, it } from 'vitest';
import { agentHoldRefusal, consentRefusal, NOTICE_TEMPLATE_CATEGORY } from './order-followup';
import { dropPercent, dropStillHolds, inCooldown, isNudgeWorthyDrop, NUDGE_COOLDOWN_DAYS, priceNudgeIntentKey } from './price-drops';
import { parseVariantIds } from './wishlist';

describe('price-drop detection', () => {
  it('measures a fall in whole percent of the old price, rounded down', () => {
    expect(dropPercent(1000, 900)).toBe(10);
    expect(dropPercent(1000, 951)).toBe(4);
    expect(dropPercent(1000, 950)).toBe(5);
    expect(dropPercent(999, 0)).toBe(100);
  });
  it('a rise, no change and bad numbers are not a drop', () => {
    expect(dropPercent(1000, 1000)).toBe(0);
    expect(dropPercent(1000, 1200)).toBe(0);
    expect(dropPercent(0, 0)).toBe(0);
    expect(dropPercent(1000, -1)).toBe(0);
    expect(dropPercent(1.5, 1)).toBe(0);
  });
  it('only a drop of at least 5% is worth a message', () => {
    expect(isNudgeWorthyDrop(1000, 950)).toBe(true);
    expect(isNudgeWorthyDrop(1000, 951)).toBe(false);
    expect(isNudgeWorthyDrop(1000, 1000)).toBe(false);
    expect(isNudgeWorthyDrop(1000, 0)).toBe(true);
  });
  it('the live price must still honour the drop', () => {
    expect(dropStillHolds(900, 900)).toBe(true);
    expect(dropStillHolds(850, 900)).toBe(true);
    expect(dropStillHolds(1000, 900)).toBe(false);
    expect(dropStillHolds(null, 900)).toBe(false);
  });
});

describe('cooldown and the dedupe key', () => {
  const now = new Date('2026-12-10T12:00:00Z');
  it('the same contact waits a week for the same variant', () => {
    expect(inCooldown(null, now)).toBe(false);
    expect(inCooldown(new Date(now.getTime() - 86_400_000), now)).toBe(true);
    expect(inCooldown(new Date(now.getTime() - (NUDGE_COOLDOWN_DAYS * 86_400_000 - 1)), now)).toBe(true);
    expect(inCooldown(new Date(now.getTime() - NUDGE_COOLDOWN_DAYS * 86_400_000), now)).toBe(false);
  });
  it('the intent key names the drop and the contact, so a replay is the same send', () => {
    expect(priceNudgeIntentKey('d1', 'c1')).toBe('price_drop:d1:c1');
    expect(priceNudgeIntentKey('d1', 'c1')).toBe(priceNudgeIntentKey('d1', 'c1'));
    expect(priceNudgeIntentKey('d1', 'c2')).not.toBe(priceNudgeIntentKey('d1', 'c1'));
  });
});

describe('consent and the agent hold apply to the nudge', () => {
  const contact = (over: object) => ({ blocked_at: null as Date | null, opted_out_at: null as Date | null, ...over });
  it('a blocked contact and an opt-out at any time refuse it', () => {
    expect(consentRefusal(contact({}), new Date(0))).toBeNull();
    expect(consentRefusal(contact({ blocked_at: new Date() }), new Date(0))).toBe('contact_blocked');
    expect(consentRefusal(contact({ opted_out_at: new Date('2020-01-01') }), new Date(0))).toBe('opted_out');
  });
  it('an agent takeover holds it (it is not a service message)', () => {
    expect(agentHoldRefusal('price_drop', true)).toBe('bot_paused');
    expect(agentHoldRefusal('price_drop', false)).toBeNull();
  });
  it('is a marketing notice kind', () => {
    expect(NOTICE_TEMPLATE_CATEGORY.price_drop).toBe('MARKETING');
  });
});

describe('a browser wishlist', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  it('keeps distinct valid ids, at most 50, and ignores the rest', () => {
    expect(parseVariantIds([A, A.toUpperCase(), 'nope', 5, null])).toEqual([A]);
    expect(parseVariantIds(Array.from({ length: 80 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`))).toHaveLength(50);
    expect(() => parseVariantIds('x')).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
