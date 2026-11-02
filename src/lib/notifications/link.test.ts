import { describe, expect, it } from 'vitest';
import { safeNotificationLink } from './link';

describe('safeNotificationLink', () => {
  it('follows same-origin relative paths', () => {
    expect(safeNotificationLink('/inbox?c=abc')).toBe('/inbox?c=abc');
    expect(safeNotificationLink('/broadcasts/b1')).toBe('/broadcasts/b1');
    expect(safeNotificationLink('/')).toBe('/');
  });
  it('ignores absolute, protocol-relative and script links and anything not a string', () => {
    for (const link of [
      'https://evil.example/',
      '//evil.example/path',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'inbox?c=abc',
      ' /inbox',
      '/inbox\n//evil',
      '/inbox\t',
      '',
      null,
      undefined,
      42,
      `/${'a'.repeat(2048)}`,
    ])
      expect(safeNotificationLink(link)).toBeNull();
  });
});
