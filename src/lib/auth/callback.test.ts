import { describe, expect, it } from 'vitest';
import { safeNextPath } from './callback';
describe('email callback destinations', () => {
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
