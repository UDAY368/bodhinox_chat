import { describe, expect, it } from 'vitest';
import { consentKeyword, marketingSuppression } from './consent';

describe('consentKeyword', () => {
  it.each(['STOP', 'stop', ' Stop. ', 'Stop!', 'unsubscribe', 'opt out', 'STOP  ALL'])('reads %j as an opt-out', (text) => {
    expect(consentKeyword(text)).toBe('opt_out');
  });
  it.each(['START', 'start', 'Subscribe', 'unstop', 'opt in'])('reads %j as an opt-in', (text) => {
    expect(consentKeyword(text)).toBe('opt_in');
  });
  it.each(['please stop calling', 'stopped', 'STOP ME', '', 'restart'])('ignores %j', (text) => {
    expect(consentKeyword(text)).toBeNull();
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
