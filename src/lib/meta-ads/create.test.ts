// Ad creation input checks (the route's only gate before the database) and the image sniffing.
import { describe, expect, it } from 'vitest';
import { isAdImage, missingCreateScopes, parseAdCreateInput } from './create';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const base = {
  adAccountId: '555', kind: 'whatsapp', name: ' Diwali offer ', dailyBudgetMinor: 50000, countries: ['in', 'IN', 'ae'],
  primaryText: 'Chat with us', imageHash: 'abcdef0123456789abcdef0123456789', publish: true,
};
const parse = (over: Record<string, unknown> = {}) => parseAdCreateInput({ ...base, ...over }, NOW);

describe('parseAdCreateInput', () => {
  it('normalises a valid request: trimmed name, deduped upper-case countries, defaults', () => {
    expect(parse()).toEqual({
      adAccountId: '555', kind: 'whatsapp', name: 'Diwali offer', dailyBudgetMinor: 50000, startTime: new Date(NOW).toISOString(), endTime: null,
      countries: ['IN', 'AE'], ageMin: 18, ageMax: 65, genders: [], primaryText: 'Chat with us', headline: null, description: null,
      linkUrl: null, leadFormId: null, ctaType: 'WHATSAPP_MESSAGE', imageHash: base.imageHash, imageUrl: null, whatsappNumber: null,
      welcomeMessage: null, publish: true,
    });
  });

  it('starts a past start now and needs an end at least a day after the start', () => {
    expect(parse({ startTime: '2026-11-01T00:00:00Z' })!.startTime).toBe(new Date(NOW).toISOString());
    expect(parse({ endTime: '2026-11-20T20:00:00Z' })).toBeNull();
    expect(parse({ endTime: '2026-11-22T00:00:00Z' })!.endTime).toBe('2026-11-22T00:00:00.000Z');
  });

  it('refuses bad budgets, audiences and accounts', () => {
    for (const bad of [
      { dailyBudgetMinor: 0 }, { dailyBudgetMinor: 1.5 }, { dailyBudgetMinor: '500' }, { countries: [] }, { countries: ['IND'] },
      { ageMin: 17 }, { ageMax: 70 }, { ageMin: 40, ageMax: 30 }, { genders: [3] }, { adAccountId: 'act_555' }, { kind: 'messenger' },
      { name: '' }, { primaryText: 'x'.repeat(2001) }, { imageHash: 'not-a-hash' }, { imageUrl: 'http://insecure.example/a.jpg' },
    ]) expect(parse(bad), JSON.stringify(bad)).toBeNull();
  });

  it('needs an https link for website ads and a form for lead ads; checks the button per kind', () => {
    expect(parse({ kind: 'website' })).toBeNull();
    expect(parse({ kind: 'website', linkUrl: 'http://shop.example' })).toBeNull();
    expect(parse({ kind: 'website', linkUrl: 'javascript:alert(1)' })).toBeNull();
    expect(parse({ kind: 'website', linkUrl: 'https://shop.example/p', ctaType: 'SHOP_NOW' })).toMatchObject({ linkUrl: 'https://shop.example/p', ctaType: 'SHOP_NOW' });
    expect(parse({ kind: 'website', linkUrl: 'https://shop.example', ctaType: 'WHATSAPP_MESSAGE' })).toBeNull();
    expect(parse({ kind: 'lead_form' })).toBeNull();
    expect(parse({ kind: 'lead_form', leadFormId: '77' })).toMatchObject({ leadFormId: '77', ctaType: 'SIGN_UP' });
    // Fields of another kind are dropped, never sent.
    expect(parse({ kind: 'lead_form', leadFormId: '77', linkUrl: 'https://x.example', welcomeMessage: 'Hi' })).toMatchObject({ linkUrl: null, welcomeMessage: null });
  });

  it('normalises a WhatsApp number to E.164 and refuses a malformed one', () => {
    expect(parse({ whatsappNumber: '91 98765 43210' })!.whatsappNumber).toBe('+919876543210');
    expect(parse({ whatsappNumber: '+91-(987)-654' })!.whatsappNumber).toBe('+91987654');
    expect(parse({ whatsappNumber: '+12' })).toBeNull();
    expect(parse({ whatsappNumber: 'call me' })).toBeNull();
  });
});

describe('isAdImage', () => {
  it('accepts JPEG and PNG by their first bytes only', () => {
    expect(isAdImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isAdImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(isAdImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBe(false);
    expect(isAdImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(false);
  });
});

describe('missingCreateScopes', () => {
  it('needs ads_management and pages_manage_ads', () => {
    expect(missingCreateScopes(['ads_management', 'pages_manage_ads'])).toEqual([]);
    expect(missingCreateScopes(['ads_read'])).toEqual(['ads_management', 'pages_manage_ads']);
  });
});
