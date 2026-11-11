// Stage 5 (5D): validation of the workspace's Instagram subscribe / unsubscribe
// settings. Storage, RLS and the per-channel state are proven on PostgreSQL in
// channel-consent.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { ConsentSettingsError, channelConsent, customKeywords, parseConsentSettingsInput } from './channel-consent';

const FLOW = '22222222-2222-4222-8222-222222222222';
const code = (body: unknown): string | null => {
  try {
    parseConsentSettingsInput(body);
    return null;
  } catch (error) {
    return error instanceof ConsentSettingsError ? error.code : 'other';
  }
};

describe('parseConsentSettingsInput', () => {
  it('stores keywords trimmed, case folded and once each, and empty replies as none', () => {
    expect(parseConsentSettingsInput({
      opt_out_keywords: [' Basta ', 'basta', 'NO  MÁS', ''],
      opt_in_keywords: ['Volver'],
      opt_out_reply: '  ',
      opt_in_reply: ' Welcome back! ',
      opt_out_flow_id: FLOW.toUpperCase(),
      opt_in_flow_id: '',
    })).toEqual({
      opt_out_keywords: ['basta', 'no más'],
      opt_in_keywords: ['volver'],
      opt_out_reply: null,
      opt_in_reply: 'Welcome back!',
      opt_out_flow_id: FLOW,
      opt_in_flow_id: null,
    });
  });

  it('defaults every missing field', () => {
    expect(parseConsentSettingsInput({})).toEqual({
      opt_out_keywords: [], opt_in_keywords: [], opt_out_reply: null, opt_in_reply: null, opt_out_flow_id: null, opt_in_flow_id: null,
    });
  });

  it('accepts 20 words each, each up to 50 characters', () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    expect(parseConsentSettingsInput({ opt_out_keywords: words, opt_in_keywords: ['x'.repeat(50)] }).opt_out_keywords).toHaveLength(20);
  });

  it.each([
    [{ opt_out_keywords: Array.from({ length: 21 }, (_, i) => `w${i}`) }, 'invalid_keywords'],
    [{ opt_in_keywords: ['x'.repeat(51)] }, 'invalid_keywords'],
    [{ opt_out_keywords: 'stop' }, 'invalid_keywords'],
    [{ opt_out_keywords: [1] }, 'invalid_keywords'],
    [{ opt_out_keywords: ['salir'], opt_in_keywords: ['SALIR'] }, 'invalid_keywords'],
    [{ opt_out_reply: 'x'.repeat(1001) }, 'invalid_reply'],
    [{ opt_in_reply: 7 }, 'invalid_reply'],
    [{ opt_out_flow_id: 'not-a-uuid' }, 'invalid_flow'],
    [{ opt_in_flow_id: 42 }, 'invalid_flow'],
    [null, 'invalid_keywords'],
    [[], 'invalid_keywords'],
  ])('refuses %j with %s', (body, expected) => {
    expect(code(body)).toBe(expected);
  });
});

describe('customKeywords and channelConsent', () => {
  it('hands the stored lists to the keyword matcher', () => {
    expect(customKeywords({ opt_out_keywords: ['basta'], opt_in_keywords: ['volver'] })).toEqual({ optOut: ['basta'], optIn: ['volver'] });
  });
  it('reads only the Instagram state, never the contact-wide WhatsApp STOP', () => {
    expect(channelConsent({ instagram_opted_out_at: '2026-11-02' }, 'instagram')).toBe('opted_out');
    expect(channelConsent({ instagram_opted_in_at: '2026-11-02' }, 'instagram')).toBe('opted_in');
    expect(channelConsent({ opted_out_at: '2026-11-02' }, 'instagram')).toBeNull();
  });
});
