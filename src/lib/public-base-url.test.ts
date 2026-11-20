import { describe, expect, it } from 'vitest';

import { publicBaseUrl } from './public-base-url';

describe('publicBaseUrl', () => {
  it('prefers APP_URL, falls back to NEXT_PUBLIC_APP_URL, and ignores a missing or broken value', () => {
    expect(publicBaseUrl({ APP_URL: 'https://app.example.com', NEXT_PUBLIC_APP_URL: 'https://x.example.com' })?.href).toBe('https://app.example.com/');
    expect(publicBaseUrl({ NEXT_PUBLIC_APP_URL: 'https://x.example.com' })?.origin).toBe('https://x.example.com');
    expect(publicBaseUrl({})).toBeUndefined();
    expect(publicBaseUrl({ APP_URL: 'not a url' })).toBeUndefined();
  });
});
