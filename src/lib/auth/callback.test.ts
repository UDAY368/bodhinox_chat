import { describe, expect, it } from 'vitest';
import { safeNextPath, postLoginPath } from './callback';
describe('email callback destinations', () => {
  it('preserves an invitation through mandatory MFA enrollment', () => {
    expect(postLoginPath('invite-test', null, true)).toBe('/mfa?next=%2Fjoin%2Finvite-test');
    expect(postLoginPath(null, '/join/invite-test', true)).toBe('/mfa?next=%2Fjoin%2Finvite-test');
    expect(postLoginPath(null, '/join/invite-test')).toBe('/join/invite-test');
    expect(postLoginPath(null, 'https://evil.test')).toBe('/dashboard');
  });
  it('permits local destinations', () =>
    expect(safeNextPath('/join/invite?tab=members')).toBe(
      '/join/invite?tab=members'
    ));
  it('rejects external, protocol-relative, backslash and control-character paths', () => {
    for (const path of [
      'https://evil.test',
      '//evil.test',
      '/\\evil',
      '/a\\b',
      '/a\r\nb',
      '',
    ])
      expect(safeNextPath(path)).toBe('/dashboard');
  });
});
