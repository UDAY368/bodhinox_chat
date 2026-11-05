import { describe, expect, it } from 'vitest';
import { listProviderFixtures } from './index';

// The provider corpus (design 1.4) holds synthetic values only. A sandbox capture
// is scrubbed before it is committed; this test refuses anything token-like,
// a real-looking email or an Indian mobile outside the reserved test range.
const TOKEN_PATTERNS: [string, RegExp][] = [
  ['Meta access token', /EAA[A-Za-z0-9]{20,}/],
  ['Razorpay live key', /rzp_live_/],
  ['Razorpay test key', /rzp_test_[A-Za-z0-9]{10,}/],
  ['Shopify access token', /shp(at|ca|pa|ss)_[A-Za-z0-9]+/],
  ['WooCommerce API key', /\b(ck|cs)_[a-f0-9]{40}\b/],
  ['Google access token', /ya29\.[A-Za-z0-9_-]+/],
  ['Google refresh token', /\b1\/\/[A-Za-z0-9_-]{20,}/],
  ['Google client secret', /GOCSPX-[A-Za-z0-9_-]+/],
  ['JWT', /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/],
  ['Bearer credential', /Bearer (?!<redacted>)[A-Za-z0-9._-]{8,}/],
  ['Basic credential', /Basic (?!<redacted>)[A-Za-z0-9+/=]{8,}/],
];
/** A JSON string value under a secret-named key must be a placeholder: `<redacted>` or `test-...`. */
const SECRET_KEY_VALUE = /"([A-Za-z_]*(?:secret|key_secret|client_secret|access_token|refresh_token|password|api_key)[A-Za-z_]*)"\s*:\s*"([^"]*)"/gi;
const PLACEHOLDER = /^(<redacted>|test-[^"]*|)$/;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
/** Indian mobile numbers, bare or with the 91 prefix, not part of a longer number. */
const IN_MOBILE = /(?<![\d.])(?:\+?91[-\s]?)?([6-9]\d{9})(?![\d])/g;
/** The reserved synthetic range: 98000 00000 to 98000 99999. */
const RESERVED_MOBILE = /^98000\d{5}$/;

export function scrubFindings(text: string): string[] {
  const findings: string[] = [];
  for (const [name, pattern] of TOKEN_PATTERNS) if (pattern.test(text)) findings.push(name);
  for (const match of text.matchAll(SECRET_KEY_VALUE)) if (!PLACEHOLDER.test(match[2])) findings.push(`value under ${match[1]}`);
  for (const match of text.matchAll(EMAIL)) {
    const domain = match[1].toLowerCase();
    if (domain !== 'example.com' && !domain.endsWith('.example.com')) findings.push(`email at ${domain}`);
  }
  for (const match of text.matchAll(IN_MOBILE)) if (!RESERVED_MOBILE.test(match[1])) findings.push('mobile outside the test range');
  return findings;
}

describe('[SEC-01] provider contract corpus is scrubbed', () => {
  const fixtures = listProviderFixtures();

  it('has fixtures for every priority-1 and priority-2 provider, each with its provenance', () => {
    const providers = new Set(fixtures.map(([p]) => p));
    for (const p of ['whatsapp', 'razorpay', 'razorpay-billing', 'google', 'shopify', 'woocommerce']) expect(providers).toContain(p);
    for (const [provider, name, raw] of fixtures) {
      const f = JSON.parse(raw) as { source?: string; capturedAt?: string; docsUrl?: string; response?: { status?: number } };
      expect(['docs-derived', 'sandbox-capture'], `${provider}/${name} source`).toContain(f.source);
      expect(f.capturedAt, `${provider}/${name} capturedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.docsUrl, `${provider}/${name} docsUrl`).toMatch(/^https:\/\//);
      expect(typeof f.response?.status, `${provider}/${name} response.status`).toBe('number');
    }
  });

  it.each(fixtures.map(([p, n, raw]) => [`${p}/${n}`, raw]))('%s holds no secrets or real personal data', (_name, raw) => {
    expect(scrubFindings(raw as string)).toEqual([]);
  });

  it('catches what it is meant to catch', () => {
    expect(scrubFindings('{"t":"EAABwzLixnjYBO1234567890abcdef"}')).toEqual(['Meta access token']);
    expect(scrubFindings('rzp_live_abc')).toEqual(['Razorpay live key']);
    expect(scrubFindings('shpat_abcdef')).toEqual(['Shopify access token']);
    for (const prefix of ['shpca_', 'shppa_', 'shpss_']) expect(scrubFindings(`${prefix}abcdef`)).toEqual(['Shopify access token']);
    expect(scrubFindings(`ck_${'a1'.repeat(20)}`)).toEqual(['WooCommerce API key']);
    expect(scrubFindings(`cs_${'0f'.repeat(20)}`)).toEqual(['WooCommerce API key']);
    expect(scrubFindings('ya29.a0AfH6SMBx-example')).toEqual(['Google access token']);
    expect(scrubFindings('1//0gExampleRefreshToken_abcdef')).toEqual(['Google refresh token']);
    expect(scrubFindings('GOCSPX-abcdef123')).toEqual(['Google client secret']);
    expect(scrubFindings('rzp_test_AbCdEf1234567')).toEqual(['Razorpay test key']);
    expect(scrubFindings('{"key_secret":"q8Wd3kLm"}')).toEqual(['value under key_secret']);
    expect(scrubFindings('{"webhook_secret": "whsec-live-123"}')).toEqual(['value under webhook_secret']);
    expect(scrubFindings('{"client_secret":"<redacted>","refresh_token":"test-refresh","password":""}')).toEqual([]);
    expect(scrubFindings('eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl')).toEqual(['JWT']);
    expect(scrubFindings('Bearer abcdefgh12345')).toEqual(['Bearer credential']);
    expect(scrubFindings('asha@gmail.com')).toEqual(['email at gmail.com']);
    expect(scrubFindings('+91 9876543210')).toEqual(['mobile outside the test range']);
    expect(scrubFindings('919800000201 buyer@example.com Bearer <redacted> 1762336800 820982911946154500')).toEqual([]);
  });
});
