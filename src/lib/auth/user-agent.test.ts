import { describe, expect, it } from 'vitest';
import { parseUserAgent, storableUserAgent } from './user-agent';

describe('parseUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'Windows', 'desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge', 'Windows', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari', 'macOS', 'desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari', 'iOS', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome', 'Android', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'Android', 'tablet'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox', 'Linux', 'desktop'],
  ])('%s', (ua, browser, os, device) => {
    expect(parseUserAgent(ua)).toEqual({ browser, os, device });
  });
  it('handles missing or unrecognised values', () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, device: 'unknown' });
    expect(parseUserAgent('curl/8.0')).toEqual({ browser: null, os: null, device: 'unknown' });
  });
  it('bounds and cleans what is stored', () => {
    expect(storableUserAgent('  a\u0000b\n ')).toBe('ab');
    expect(storableUserAgent('x'.repeat(600))).toHaveLength(512);
    expect(storableUserAgent('')).toBeNull();
  });
});
