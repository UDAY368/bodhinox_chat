import { describe, expect, it } from 'vitest';
import { clientIp, holdClientHash, isLocalDate } from './public';

const req = (headers: Record<string, string>) => new Request('http://localhost:3000/api/public/booking/x', { headers });

describe('clientIp', () => {
  it('uses the rightmost forwarded hop (the one Railway appends), not a client-supplied leftmost one', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed-1, 9.9.9.9' }))).toBe(clientIp(req({ 'x-forwarded-for': 'spoofed-2, 9.9.9.9' })));
    expect(clientIp(req({ 'x-forwarded-for': '9.9.9.9 , ' }))).toBe('9.9.9.9');
    expect(clientIp(req({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    expect(clientIp(req({}))).toBe('unknown');
  });
});

describe('holdClientHash', () => {
  it('is a stable keyed hash of the client IP, not the plain sha256', () => {
    const a = holdClientHash(req({ 'x-forwarded-for': 'x, 9.9.9.9' }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(holdClientHash(req({ 'x-forwarded-for': 'y, 9.9.9.9' }))).toBe(a);
    expect(holdClientHash(req({ 'x-forwarded-for': '9.9.9.8' }))).not.toBe(a);
  });
});

describe('isLocalDate', () => {
  it('refuses impossible calendar dates before they reach a ::date cast', () => {
    expect(isLocalDate('2026-11-09')).toBe(true);
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('9999-12-31')).toBe(false);
  });
});
