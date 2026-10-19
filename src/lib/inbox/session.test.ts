import { describe, expect, it } from 'vitest';
import { getSessionWindow, latestCustomerMessageAt, matchesSessionFilter } from './session';

const now = Date.parse('2026-10-19T12:00:00Z');
describe('WhatsApp Inbox session categories', () => {
  it('keeps the window active until exactly 24 hours after the latest customer message', () => {
    const timestamp = '2026-10-18T12:00:00Z';
    expect(getSessionWindow(timestamp, now - 1).active).toBe(true);
    expect(getSessionWindow(timestamp, now).active).toBe(false);
    expect(getSessionWindow(timestamp, now + 1).active).toBe(false);
  });
  it.each([null, undefined, '', 'invalid'])('treats a missing or invalid customer timestamp as expired (%s)', (timestamp) => {
    expect(matchesSessionFilter(timestamp, 'active', now)).toBe(false);
    expect(matchesSessionFilter(timestamp, 'expired', now)).toBe(true);
    expect(matchesSessionFilter(timestamp, 'all', now)).toBe(true);
  });
  it('returns precise remaining minutes inside the last hour', () => {
    expect(getSessionWindow('2026-10-18T12:15:00Z', now).remainingMs).toBe(15 * 60_000);
  });
  it('reopens on a customer reply, ignores business replies, and resists out-of-order events', () => {
    const old = '2026-10-17T12:00:00Z';
    const latest = '2026-10-19T11:00:00Z';
    expect(latestCustomerMessageAt(old, { sender_type: 'agent', created_at: latest })).toBe(old);
    expect(latestCustomerMessageAt(old, { sender_type: 'bot', created_at: latest })).toBe(old);
    expect(latestCustomerMessageAt(old, { sender_type: 'customer', created_at: latest })).toBe(latest);
    expect(latestCustomerMessageAt(latest, { sender_type: 'customer', created_at: old })).toBe(latest);
    expect(matchesSessionFilter(latest, 'active', now)).toBe(true);
    expect(matchesSessionFilter(old, 'expired', now)).toBe(true);
  });
});
