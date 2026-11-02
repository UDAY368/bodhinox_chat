import { describe, expect, it } from 'vitest';
import {
  BUSINESS_PROFILE_LIMITS,
  PROFILE_PHOTO_MAX_BYTES,
  parseBusinessProfileUpdate,
  toBusinessProfile,
  validateProfilePhoto,
} from './business-profile';

const ok = (body: unknown) => {
  const r = parseBusinessProfileUpdate(body);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.update;
};
const err = (body: unknown) => {
  const r = parseBusinessProfileUpdate(body);
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('parseBusinessProfileUpdate', () => {
  it('keeps only the fields given, trimmed', () => {
    expect(ok({ about: '  Hi  ', websites: [' https://a.example ', ''] })).toEqual({ about: 'Hi', websites: ['https://a.example'] });
    expect(ok({})).toEqual({});
  });

  it('enforces Meta length limits at the boundary', () => {
    expect(ok({ about: 'a'.repeat(139) }).about).toHaveLength(139);
    expect(err({ about: 'a'.repeat(140) })).toEqual({ field: 'about', reason: 'tooLong' });
    expect(err({ address: 'a'.repeat(BUSINESS_PROFILE_LIMITS.address + 1) })).toEqual({ field: 'address', reason: 'tooLong' });
    expect(ok({ description: 'd'.repeat(512) }).description).toHaveLength(512);
    expect(err({ description: 'd'.repeat(513) })).toEqual({ field: 'description', reason: 'tooLong' });
    expect(err({ email: `${'a'.repeat(120)}@example.com` })).toEqual({ field: 'email', reason: 'tooLong' });
  });

  it('allows clearing address, description and email, but not about', () => {
    expect(ok({ address: '', description: '', email: '' })).toEqual({ address: '', description: '', email: '' });
    expect(err({ about: '   ' })).toEqual({ field: 'about', reason: 'empty' });
  });

  it('validates email', () => {
    expect(ok({ email: 'hi@acme.example' }).email).toBe('hi@acme.example');
    expect(err({ email: 'not-an-email' })).toEqual({ field: 'email', reason: 'invalid' });
  });

  it('accepts at most two http(s) websites of 256 chars', () => {
    expect(err({ websites: ['https://a.example', 'https://b.example', 'https://c.example'] })).toEqual({ field: 'websites', reason: 'tooMany' });
    expect(err({ websites: ['javascript:alert(1)'] })).toEqual({ field: 'websites', reason: 'invalid' });
    expect(err({ websites: ['ftp://a.example'] })).toEqual({ field: 'websites', reason: 'invalid' });
    expect(err({ websites: ['https://user:pw@a.example'] })).toEqual({ field: 'websites', reason: 'invalid' });
    expect(err({ websites: [`https://a.example/${'x'.repeat(250)}`] })).toEqual({ field: 'websites', reason: 'tooLong' });
    expect(err({ websites: 'https://a.example' })).toEqual({ field: 'websites', reason: 'type' });
    expect(ok({ websites: [] })).toEqual({ websites: [] });
  });

  it("accepts only Meta's verticals", () => {
    expect(ok({ vertical: 'RETAIL' })).toEqual({ vertical: 'RETAIL' });
    expect(err({ vertical: 'retail' })).toEqual({ field: 'vertical', reason: 'invalid' });
    expect(err({ vertical: 'SPACESHIPS' })).toEqual({ field: 'vertical', reason: 'invalid' });
  });

  it('rejects wrong types, control characters and non-objects', () => {
    expect(err(null)).toEqual({ field: 'body', reason: 'type' });
    expect(err([])).toEqual({ field: 'body', reason: 'type' });
    expect(err({ about: 5 })).toEqual({ field: 'about', reason: 'type' });
    expect(err({ address: 'a\u0000b' })).toEqual({ field: 'address', reason: 'type' });
    expect(err({ about: 'line\nbreak' })).toEqual({ field: 'about', reason: 'invalid' });
    expect(ok({ description: 'two\nlines' }).description).toBe('two\nlines');
  });
});

describe('validateProfilePhoto', () => {
  it('accepts JPEG/PNG up to 5 MB', () => {
    expect(validateProfilePhoto({ type: 'image/png', size: 1000 })).toBeNull();
    expect(validateProfilePhoto({ type: 'image/jpeg', size: PROFILE_PHOTO_MAX_BYTES })).toBeNull();
    expect(validateProfilePhoto({ type: 'image/jpeg', size: PROFILE_PHOTO_MAX_BYTES + 1 })).toBe('tooLarge');
    expect(validateProfilePhoto({ type: 'image/gif', size: 10 })).toBe('type');
    expect(validateProfilePhoto({ type: 'image/png', size: 0 })).toBe('empty');
  });
});

describe('toBusinessProfile', () => {
  it('fills defaults and drops junk', () => {
    expect(toBusinessProfile({ about: 'a', websites: ['https://x.example', 5 as unknown as string] })).toEqual({
      about: 'a', address: '', description: '', email: '', websites: ['https://x.example'], vertical: '', profile_picture_url: null,
    });
  });
});
