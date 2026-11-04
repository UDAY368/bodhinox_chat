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
