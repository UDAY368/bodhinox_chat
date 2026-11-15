import { describe, expect, it } from 'vitest';
import type { MessageTemplate } from '@/types';
import { mapNewArrivalCards, publicImageLink, type CardProduct } from './new-arrivals';
import { mergeCampaignCards, parseCampaignSendExtras, storedCampaignSendExtras } from '@/lib/whatsapp/template-send-params';

const base = {
  id: 't', user_id: 'u', name: 'arrivals', category: 'Marketing', language: 'en_US', body_text: 'New in, {{1}}', created_at: '2026-01-01T00:00:00Z',
} as MessageTemplate;
const card = (body: string, extra: Record<string, unknown> = {}) => ({
  header_type: 'image' as const, header_media_url: 'https://cdn.test/sample.png', body_text: body,
  buttons: [{ type: 'URL' as const, text: 'View', url: 'https://shop.test/s/x/{{1}}', example: 'https://shop.test/s/x/p/1' }], ...extra,
});
const carousel = (cards: ReturnType<typeof card>[]): MessageTemplate => ({ ...base, template_kind: 'carousel', cards });
const product = (n: number, over: Partial<CardProduct> = {}): CardProduct => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, name: `Oil ${n}`, priceMinor: 25000 * n, currency: 'INR', imageUrl: `https://app.test/api/public/store/x/images/${n}`, ...over,
});

describe('mapNewArrivalCards', () => {
  it('fills image, name, price and the product path for each card in order', () => {
    const mapped = mapNewArrivalCards(carousel([card('{{1}} at {{2}}'), card('{{1}}')]), [product(1), product(2)]);
    expect(mapped.variables).toEqual({
      c1_1: { type: 'static', value: 'Oil 1' }, c1_2: { type: 'static', value: expect.stringContaining('250') },
      c2_1: { type: 'static', value: 'Oil 2' },
    });
    expect(mapped.cards).toEqual([
      { headerMediaUrl: product(1).imageUrl, buttonParams: { 0: `p/${product(1).id}` } },
      { headerMediaUrl: product(2).imageUrl, buttonParams: { 0: `p/${product(2).id}` } },
    ]);
  });

  it('sets no button value when the card button has no variable', () => {
    const plain = card('Hello', { buttons: [{ type: 'URL' as const, text: 'Shop', url: 'https://shop.test/all' }] });
    expect(mapNewArrivalCards(carousel([plain]), [product(1)]).cards).toEqual([{ headerMediaUrl: product(1).imageUrl }]);
  });

  it('refuses a card count that does not match, a non-carousel, a video card and too many variables', () => {
    expect(() => mapNewArrivalCards(carousel([card('a'), card('b')]), [product(1)])).toThrow(/exactly 2/);
    expect(() => mapNewArrivalCards(base, [product(1)])).toThrow(/carousel/);
    expect(() => mapNewArrivalCards(carousel([card('a', { header_type: 'video' })]), [product(1)])).toThrow(/image/);
    expect(() => mapNewArrivalCards(carousel([card('{{1}} {{2}} {{3}}')]), [product(1)])).toThrow(/more than/);
  });
});

describe('public image link', () => {
  it('uses the public shop image route on the app address', () => {
    expect(publicImageLink('https://app.test/', 'my-shop', 'abc')).toBe('https://app.test/api/public/store/my-shop/images/abc');
  });
});

describe('campaign card extras', () => {
  it('accepts https image links and button values, drops nothing silently', () => {
    const parsed = parseCampaignSendExtras({ cards: [{ headerMediaUrl: 'https://app.test/i/1', buttonParams: { 0: 'p/1' } }, null] });
    expect(parsed).toEqual({ ok: true, value: { cards: [{ headerMediaUrl: 'https://app.test/i/1', buttonParams: { 0: 'p/1' } }, {}] } });
  });

  it('refuses a non-https or credentialed image link', () => {
    expect(parseCampaignSendExtras({ cards: [{ headerMediaUrl: 'http://app.test/i/1' }] }).ok).toBe(false);
    expect(parseCampaignSendExtras({ cards: [{ headerMediaUrl: 'https://u:p@app.test/i/1' }] }).ok).toBe(false);
    expect(parseCampaignSendExtras({ cards: 'x' }).ok).toBe(false);
    expect(parseCampaignSendExtras({ cards: Array.from({ length: 11 }, () => ({})) }).ok).toBe(false);
  });

  it('reads stored extras back and lays them over each recipient\'s frozen card values', () => {
    const stored = storedCampaignSendExtras({ cards: [{ headerMediaUrl: 'https://app.test/i/1', buttonParams: { 0: 'p/1' } }, {}] });
    expect(mergeCampaignCards([{ body: ['Oil 1'] }, { body: ['Oil 2'] }], stored.cards)).toEqual([
      { body: ['Oil 1'], headerMediaUrl: 'https://app.test/i/1', buttonParams: { 0: 'p/1' } }, { body: ['Oil 2'] },
    ]);
    expect(mergeCampaignCards([{ body: ['x'] }], undefined)).toEqual([{ body: ['x'] }]);
  });
});
