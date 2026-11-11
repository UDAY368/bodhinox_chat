import { describe, expect, it } from 'vitest';
import { instagramWindow, instagramWindowBanner } from './window';

const now = new Date('2026-11-10T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const H = 3_600_000;
const M = 60_000;
const D = 24 * H;

describe('instagram messaging window', () => {
  it('allows any send inside 24 hours, untagged', () => {
    expect(instagramWindow({ lastCustomerAt: ago(23 * H + 59 * M), sender: 'automated', humanAgentEnabled: true, now }))
      .toMatchObject({ allowed: true, humanAgentTag: false });
    expect(instagramWindow({ lastCustomerAt: ago(H), sender: 'staff', humanAgentEnabled: true, now }))
      .toMatchObject({ allowed: true, humanAgentTag: false });
  });

  it('refuses automated sends after 24 hours, whatever the flag', () => {
    for (const humanAgentEnabled of [false, true])
      expect(instagramWindow({ lastCustomerAt: ago(24 * H + M), sender: 'automated', humanAgentEnabled, now }))
        .toEqual({ allowed: false, reason: 'instagram_window_closed' });
  });

  it('allows a staff reply at 3 days only with the Human Agent flag, and tags it', () => {
    expect(instagramWindow({ lastCustomerAt: ago(3 * D), sender: 'staff', humanAgentEnabled: false, now }))
      .toEqual({ allowed: false, reason: 'instagram_window_closed' });
    expect(instagramWindow({ lastCustomerAt: ago(3 * D), sender: 'staff', humanAgentEnabled: true, now }))
      .toMatchObject({ allowed: true, humanAgentTag: true });
  });

  it('refuses everything after 7 days, and when the customer never wrote', () => {
    expect(instagramWindow({ lastCustomerAt: ago(7 * D + M), sender: 'staff', humanAgentEnabled: true, now }))
      .toEqual({ allowed: false, reason: 'instagram_window_closed' });
    expect(instagramWindow({ lastCustomerAt: null, sender: 'staff', humanAgentEnabled: true, now }))
      .toEqual({ allowed: false, reason: 'instagram_window_closed' });
  });

  it('drives the composer banner', () => {
    expect(instagramWindowBanner(ago(H), false, now)).toEqual({ kind: 'open', closesAt: new Date(ago(H).getTime() + D) });
    expect(instagramWindowBanner(ago(2 * D), true, now).kind).toBe('human_agent');
    expect(instagramWindowBanner(ago(2 * D), false, now)).toEqual({ kind: 'closed' });
  });
});

describe('click-to-Direct 7-day window', () => {
  const base = { sender: 'automated' as const, humanAgentEnabled: false, now };
  const closed = { allowed: false, reason: 'instagram_window_closed' };

  it('lets an automated send through for 7 days after an ad message, untagged', () => {
    const decision = instagramWindow({ ...base, lastCustomerAt: ago(5 * D), adReferralAt: ago(5 * D), ctdEnabled: true });
    expect(decision).toEqual({ allowed: true, humanAgentTag: false, closesAt: new Date(ago(5 * D).getTime() + 7 * D) });
  });

  it('closes at exactly 7 days from the ad message', () => {
    expect(instagramWindow({ ...base, lastCustomerAt: ago(7 * D - M), adReferralAt: ago(7 * D - M), ctdEnabled: true }).allowed).toBe(true);
    expect(instagramWindow({ ...base, lastCustomerAt: ago(7 * D), adReferralAt: ago(7 * D), ctdEnabled: true })).toEqual(closed);
  });

  it('is ignored without the flag, and without an ad message', () => {
    expect(instagramWindow({ ...base, lastCustomerAt: ago(5 * D), adReferralAt: ago(5 * D), ctdEnabled: false })).toEqual(closed);
    expect(instagramWindow({ ...base, lastCustomerAt: ago(5 * D), adReferralAt: ago(5 * D) })).toEqual(closed);
    expect(instagramWindow({ ...base, lastCustomerAt: ago(5 * D), adReferralAt: null, ctdEnabled: true })).toEqual(closed);
  });

  it('keeps the later close when a newer message outlasts the ad window', () => {
    // Ad message 6.5 days ago, a reply 1 hour ago: the 24 h window (to +23 h) outlasts the ad window (to +12 h).
    const decision = instagramWindow({ ...base, lastCustomerAt: ago(H), adReferralAt: ago(6.5 * D), ctdEnabled: true });
    expect(decision).toMatchObject({ allowed: true, closesAt: new Date(ago(H).getTime() + D) });
  });

  it('does not trust an ad time from the future', () => {
    expect(instagramWindow({ ...base, lastCustomerAt: ago(2 * D), adReferralAt: new Date(now.getTime() + 5 * M), ctdEnabled: true })).toEqual(closed);
  });

  it('never tags a send for the ad window, and leaves the 24 h rules alone', () => {
    expect(instagramWindow({ lastCustomerAt: ago(3 * D), adReferralAt: ago(3 * D), ctdEnabled: true, sender: 'staff', humanAgentEnabled: true, now }))
      .toMatchObject({ allowed: true, humanAgentTag: false });
    expect(instagramWindow({ ...base, lastCustomerAt: ago(H), adReferralAt: null, ctdEnabled: true })).toMatchObject({ allowed: true });
  });
});
