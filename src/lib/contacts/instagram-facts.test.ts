import { describe, expect, it } from 'vitest';

import { windowOpenUntil } from './instagram-facts';

describe('Instagram messaging window on the contact facts', () => {
  const now = new Date('2026-11-11T12:00:00Z');

  it('is open for 24 hours after the customer last wrote', () => {
    expect(windowOpenUntil(new Date('2026-11-11T02:00:00Z'), now)?.toISOString()).toBe('2026-11-12T02:00:00.000Z');
  });

  it('is closed (null) after 24 hours, when they never wrote, or for an invalid time', () => {
    expect(windowOpenUntil(new Date('2026-11-10T11:59:59Z'), now)).toBeNull();
    expect(windowOpenUntil(new Date('2026-11-10T12:00:00Z'), now)).toBeNull();
    expect(windowOpenUntil(null, now)).toBeNull();
    expect(windowOpenUntil(new Date('nonsense'), now)).toBeNull();
  });
});
