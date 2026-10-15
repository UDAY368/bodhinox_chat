import { describe, expect, it } from 'vitest';
import { assertCsrf, assertOrigin, hashToken } from './csrf';

describe('cookie mutation protection', () => {
  it('requires the configured exact origin rather than trusting Host', () => {
    process.env.APP_URL = 'https://crm.example.test';
    expect(() =>
      assertOrigin(
        new Request('https://internal.invalid/api', {
          headers: { origin: 'https://crm.example.test' },
        })
      )
    ).not.toThrow();
    for (const origin of [
      null,
      'https://evil.test',
      'https://crm.example.test.evil.test',
    ]) {
      expect(() =>
        assertOrigin(
          new Request('https://crm.example.test/api', {
            headers: origin ? { origin } : {},
          })
        )
      ).toThrow();
    }
  });
  it('requires a random token matching the database digest', () => {
    const token = 'random-csrf-token-value';
    expect(() =>
      assertCsrf(
        new Request('https://crm.example.test', {
          headers: { 'x-csrf-token': token },
        }),
        hashToken(token)
      )
    ).not.toThrow();
    expect(() =>
      assertCsrf(new Request('https://crm.example.test'), hashToken(token))
    ).toThrow();
    expect(() =>
      assertCsrf(
        new Request('https://crm.example.test', {
          headers: { 'x-csrf-token': 'other' },
        }),
        hashToken(token)
      )
    ).toThrow();
  });
});
