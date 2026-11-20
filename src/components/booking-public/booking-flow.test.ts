import { describe, expect, it } from 'vitest';
import {
  MAX_WAIT_MS, nextPollDelay, preselect, priceText, serviceSelection, tokenFromManagePath,
} from './flow-helpers';

const loc = (id: string, staff: string[] = []) => ({ id, staff: staff.map((s) => ({ id: s })) });

describe('serviceSelection', () => {
  const single = { id: 'svc-1', locations: [loc('loc-1')] };
  const multi = { id: 'svc-2', locations: [loc('loc-a'), loc('loc-b')] };

  it('re-clicking the chosen service changes nothing (it used to clear the only location for good)', () => {
    expect(serviceSelection('svc-1', single)).toBeNull();
  });

  it('a service with one location gets that location at once', () => {
    expect(serviceSelection(null, single)).toEqual({ serviceId: 'svc-1', locationId: 'loc-1' });
    expect(serviceSelection('svc-2', single)).toEqual({ serviceId: 'svc-1', locationId: 'loc-1' });
  });

  it('a service with several locations waits for the customer to pick one', () => {
    expect(serviceSelection('svc-1', multi)).toEqual({ serviceId: 'svc-2', locationId: null });
  });
});

describe('preselect (direct links)', () => {
  const services = [
    { id: 'svc-a', locations: [loc('loc-1', ['st-1', 'st-2'])] },
    { id: 'svc-b', locations: [loc('loc-1', ['st-2']), loc('loc-2', ['st-3'])] },
    { id: 'svc-c', locations: [loc('loc-2', ['st-3'])] },
  ];

  it('opens on the times for a service link with one place', () => {
    expect(preselect(services, { service: 'svc-a' })).toEqual({ serviceId: 'svc-a', locationId: 'loc-1', staffId: '', staffFilter: null, step: 'time' });
  });

  it('keeps step 1 when the linked service still needs a place', () => {
    expect(preselect(services, { service: 'svc-b' })).toMatchObject({ serviceId: 'svc-b', locationId: null, step: 'service' });
  });

  it('a staff link lists only that practitioner’s services and picks their place', () => {
    expect(preselect(services, { staff: 'st-3' })).toEqual({ serviceId: null, locationId: null, staffId: 'st-3', staffFilter: 'st-3', step: 'service' });
    expect(preselect(services, { staff: 'st-1' })).toEqual({ serviceId: 'svc-a', locationId: 'loc-1', staffId: 'st-1', staffFilter: 'st-1', step: 'time' });
    expect(preselect(services, { service: 'svc-b', staff: 'st-3' })).toMatchObject({ serviceId: 'svc-b', locationId: 'loc-2', staffId: 'st-3', step: 'time' });
  });

  it('ignores ids that are not on the page, wrong types and odd casing', () => {
    expect(preselect(services, { service: 'nope', staff: 'ghost' })).toEqual({ serviceId: null, locationId: null, staffId: '', staffFilter: null, step: 'service' });
    expect(preselect(services, { service: ['svc-a', 'svc-b'] })).toMatchObject({ serviceId: null });
    expect(preselect(services, { service: 'SVC-A' })).toMatchObject({ serviceId: 'svc-a' });
    expect(preselect(services, { service: 'x'.repeat(65) })).toMatchObject({ serviceId: null });
  });

  it('a service the linked practitioner does not offer is ignored, the practitioner kept', () => {
    expect(preselect(services, { service: 'svc-c', staff: 'st-1' })).toMatchObject({ serviceId: 'svc-a', staffId: 'st-1' });
  });

  it('a page with one service and one place opens on the times', () => {
    expect(preselect([services[0]], {})).toMatchObject({ serviceId: 'svc-a', locationId: 'loc-1', step: 'time' });
  });
});

describe('priceText', () => {
  it('says Free for no price or zero', () => {
    expect(priceText(null, null, 'en-IN', 'Free')).toBe('Free');
    expect(priceText(0, 'INR', 'en-IN', 'Free')).toBe('Free');
  });
  it('formats minor units in the currency', () => {
    expect(priceText(49_900, 'INR', 'en-IN', 'Free')).toBe('₹499.00');
    expect(priceText(1_000, 'JPY', 'en-US', 'Free')).toBe('¥1,000');
  });
  it('gives null for an amount with no usable currency', () => {
    expect(priceText(500, null, 'en', 'Free')).toBeNull();
    expect(priceText(500, 'NOPE', 'en', 'Free')).toBeNull();
  });
});

describe('nextPollDelay', () => {
  const live = { state: 'held' as const, msToExpiry: 5 * 60_000 };
  it('polls every 3 s at first, then backs off', () => {
    expect(nextPollDelay({ ...live, elapsedMs: 0 })).toBe(3_000);
    expect(nextPollDelay({ ...live, elapsedMs: 3 * 60_000 })).toBe(6_000);
    expect(nextPollDelay({ ...live, elapsedMs: 10 * 60_000 })).toBe(15_000);
    expect(nextPollDelay({ ...live, elapsedMs: 0, failed: true })).toBe(30_000);
  });
  it('stops on a final state, after expiry, and after the maximum wait', () => {
    for (const state of ['confirmed', 'expired', 'cancelled'] as const) expect(nextPollDelay({ state, elapsedMs: 0, msToExpiry: 60_000 })).toBeNull();
    expect(nextPollDelay({ state: 'held', elapsedMs: 0, msToExpiry: -30_000 })).toBe(3_000);
    expect(nextPollDelay({ state: 'held', elapsedMs: 0, msToExpiry: -61_000 })).toBeNull();
    expect(nextPollDelay({ ...live, elapsedMs: MAX_WAIT_MS })).toBeNull();
  });
  it('keeps waiting for a payment past the original hold expiry', () => {
    expect(nextPollDelay({ state: 'payment_pending', elapsedMs: 20 * 60_000, msToExpiry: -10 * 60_000 })).toBe(15_000);
  });
});

describe('tokenFromManagePath', () => {
  it('accepts only a well-formed manage path', () => {
    const token = 'A'.repeat(43);
    expect(tokenFromManagePath(`/my-booking/${token}`)).toBe(token);
    expect(tokenFromManagePath(`https://evil.example/my-booking/${token}`)).toBeNull();
    expect(tokenFromManagePath('/my-booking/short')).toBeNull();
    expect(tokenFromManagePath(undefined)).toBeNull();
  });
});
