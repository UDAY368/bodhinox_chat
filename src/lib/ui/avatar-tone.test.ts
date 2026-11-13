import { describe, expect, it } from 'vitest';
import { avatarTone, initials } from './avatar-tone';

describe('avatarTone', () => {
  it('gives the same name the same tint', () => {
    expect(avatarTone('Divya Patel')).toBe(avatarTone('Divya Patel'));
    expect(avatarTone('')).toMatch(/^bg-/);
  });
});

describe('initials', () => {
  it('takes up to two initials', () => {
    expect(initials('Divya Patel')).toBe('DP');
    expect(initials('  sana  ')).toBe('S');
    expect(initials('Anna Maria Lopez')).toBe('AM');
  });

  it('falls back for empty names and keeps emoji whole', () => {
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
    expect(initials('😀 Ravi')).toBe('😀R');
  });
});
