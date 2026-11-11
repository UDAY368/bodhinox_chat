import { describe, expect, it } from 'vitest';
import { consentKeyword, marketingSuppression, normalizeConsentKeyword, quickReplyOptOut } from './consent';

describe('consentKeyword', () => {
  it.each(['STOP', 'stop', ' Stop. ', 'Stop!', 'unsubscribe', 'opt out', 'STOP  ALL', 'Stop promotions', 'STOP_PROMOTIONS', 'opt-out'])('reads %j as an opt-out', (text) => {
    expect(consentKeyword(text)).toBe('opt_out');
  });
  it.each(['START', 'start', 'Subscribe', 'unstop', 'opt in'])('reads %j as an opt-in', (text) => {
    expect(consentKeyword(text)).toBe('opt_in');
  });
  it.each(['please stop calling', 'stopped', 'STOP ME', '', 'restart'])('ignores %j', (text) => {
    expect(consentKeyword(text)).toBeNull();
  });
});

describe("consentKeyword with a workspace's own words (Stage 5)", () => {
  const custom = { optOut: ['basta', 'no más', '그만'], optIn: ['volver', 'sim'] };
  it.each(['basta', ' BASTA ', 'No  más', '그만'])('reads %j as an opt-out', (text) => {
    expect(consentKeyword(text, custom)).toBe('opt_out');
  });
  it.each(['volver', 'SIM', ' Sim '])('reads %j as an opt-in', (text) => {
    expect(consentKeyword(text, custom)).toBe('opt_in');
  });
  it("keeps the built-in words alongside the workspace's own", () => {
    expect(consentKeyword('STOP', custom)).toBe('opt_out');
    expect(consentKeyword('start', custom)).toBe('opt_in');
  });
  it.each(['basta ya', 'bastante', 'volver!', ''])('matches exactly after trimming and case folding, so %j is ignored', (text) => {
    expect(consentKeyword(text, custom)).toBeNull();
  });
  it('lets an opt-out word win over an opt-in word, and leaves the built-in set alone without custom words', () => {
    expect(consentKeyword('start', { optOut: ['start'], optIn: [] })).toBe('opt_out');
    expect(consentKeyword('basta')).toBeNull();
    expect(consentKeyword('basta', null)).toBeNull();
  });
  it('normalizes stored words the way messages are compared', () => {
    expect(normalizeConsentKeyword('  No   MÁS ')).toBe('no más');
  });
});

describe('quickReplyOptOut', () => {
  it('opts out when the label or the payload of a template tap is an opt-out keyword', () => {
    expect(quickReplyOptOut('Stop promotions', 'PROMO_STOP_X')).toBe('opt_out');
    expect(quickReplyOptOut('No thanks', 'UNSUBSCRIBE')).toBe('opt_out');
    expect(quickReplyOptOut('Stop', null)).toBe('opt_out');
  });
  it('never opts in from a tap, and ignores ordinary buttons', () => {
    expect(quickReplyOptOut('Start', 'START')).toBeNull();
    expect(quickReplyOptOut('Track my order', 'TRACK')).toBeNull();
    expect(quickReplyOptOut(null, null)).toBeNull();
  });
});

describe('marketingSuppression', () => {
  it('allows a contact with no consent flags', () => {
    expect(marketingSuppression({ opted_out_at: null, blocked_at: null })).toBeNull();
    expect(marketingSuppression(null)).toBeNull();
  });
  it('names the reason, blocked first', () => {
    expect(marketingSuppression({ opted_out_at: '2026-11-01T00:00:00Z' })).toBe('Contact opted out');
    expect(marketingSuppression({ opted_out_at: '2026-11-01T00:00:00Z', blocked_at: '2026-11-01T00:00:00Z' })).toBe('Contact is blocked');
  });
});
