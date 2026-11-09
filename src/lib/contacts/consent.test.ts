import { describe, expect, it } from 'vitest';
import { consentKeyword, marketingSuppression, quickReplyOptOut } from './consent';

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
