import { describe, expect, it } from 'vitest';
import { instagramConfig, instagramEnabled, instagramStatus, missingScopes } from './config';

const FULL = {
  INSTAGRAM_ENABLED: 'true',
  INSTAGRAM_APP_ID: '1234567890',
  INSTAGRAM_APP_SECRET: 'test-only-ig-secret, test-only-ig-old',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify',
  META_APP_SECRET: 'test-only-meta-secret',
  APP_URL: 'https://app.example.test/',
};

describe('instagram config gate', () => {
  it('is off by default and with any flag value but exactly "true"', () => {
    expect(instagramEnabled({})).toBe(false);
    expect(instagramConfig({})).toBeNull();
    expect(instagramStatus({})).toEqual({ enabled: false, reason: 'flag_off' });
    expect(instagramStatus({ ...FULL, INSTAGRAM_ENABLED: 'TRUE' })).toEqual({ enabled: false, reason: 'flag_off' });
    expect(instagramStatus({ ...FULL, INSTAGRAM_ENABLED: '1' })).toEqual({ enabled: false, reason: 'flag_off' });
  });

  it.each(['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'APP_URL'])(
    'reports not_configured when %s is missing', (key) => {
      const env = { ...FULL, [key]: '' };
      expect(instagramConfig(env)).toBeNull();
      expect(instagramStatus(env)).toEqual({ enabled: false, reason: 'not_configured' });
    });

  it('refuses a non-numeric app id', () => {
    expect(instagramConfig({ ...FULL, INSTAGRAM_APP_ID: 'abc' })).toBeNull();
  });

  it('builds the redirect URI and the webhook secret list (Instagram secrets, then META_APP_SECRET)', () => {
    const config = instagramConfig(FULL)!;
    expect(config.appSecret).toBe('test-only-ig-secret');
    expect(config.webhookSecrets).toBe('test-only-ig-secret,test-only-ig-old,test-only-meta-secret');
    expect(config.redirectUri).toBe('https://app.example.test/api/instagram/callback');
    expect(config.humanAgentEnabled).toBe(false);
    expect(instagramConfig({ ...FULL, INSTAGRAM_REDIRECT_URI: 'https://other.example.test/cb' })!.redirectUri)
      .toBe('https://other.example.test/cb');
    expect(instagramConfig({ ...FULL, INSTAGRAM_HUMAN_AGENT_ENABLED: 'true' })!.humanAgentEnabled).toBe(true);
  });

  it('never exposes a secret or the verify token in the status', () => {
    const status = instagramStatus(FULL);
    expect(status).toEqual({ enabled: true, appId: '1234567890', humanAgentEnabled: false });
    const text = JSON.stringify(status);
    for (const secret of ['test-only-ig-secret', 'test-only-meta-secret', 'test-only-verify']) expect(text).not.toContain(secret);
  });

  it('lists the scopes a feature lacks', () => {
    expect(missingScopes(['instagram_business_basic', 'instagram_business_manage_messages'], 'dm')).toEqual([]);
    expect(missingScopes(['instagram_business_basic', 'instagram_business_manage_messages'], 'comments'))
      .toEqual(['instagram_business_manage_comments']);
    expect(missingScopes([], 'dm')).toEqual(['instagram_business_basic', 'instagram_business_manage_messages']);
  });
});
