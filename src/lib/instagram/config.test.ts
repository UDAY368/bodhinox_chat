import { describe, expect, it } from 'vitest';
import { instagramConfig, instagramEnabled, instagramScheduledAutomationsEnabled, instagramStatus, missingScopes, pageLoginConfig } from './config';

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
    expect(status).toEqual({ enabled: true, appId: '1234567890', humanAgentEnabled: false, shareToStoryEnabled: false, pageLoginAvailable: false });
    const text = JSON.stringify(status);
    for (const secret of ['test-only-ig-secret', 'test-only-meta-secret', 'test-only-verify']) expect(text).not.toContain(secret);
  });

  it('keeps Share-to-Story off unless its own flag is exactly "true" (Stage 4)', () => {
    expect(instagramConfig(FULL)!.shareToStoryEnabled).toBe(false);
    expect(instagramConfig({ ...FULL, INSTAGRAM_SHARE_TO_STORY_ENABLED: '1' })!.shareToStoryEnabled).toBe(false);
    expect(instagramConfig({ ...FULL, INSTAGRAM_SHARE_TO_STORY_ENABLED: 'true' })!.shareToStoryEnabled).toBe(true);
    // The flag alone never turns Instagram on.
    expect(instagramConfig({ INSTAGRAM_SHARE_TO_STORY_ENABLED: 'true' })).toBeNull();
  });

  describe('optional Facebook Page login (Stage 4)', () => {
    const PAGE = { ...FULL, INSTAGRAM_PAGE_LOGIN_ENABLED: 'true', META_APP_ID: '9876543210' };

    it('is off unless the flag, Instagram, the Facebook app id and its secret are all set', () => {
      expect(pageLoginConfig(FULL)).toBeNull();
      expect(pageLoginConfig({ ...PAGE, INSTAGRAM_PAGE_LOGIN_ENABLED: 'yes' })).toBeNull();
      expect(pageLoginConfig({ ...PAGE, META_APP_ID: '' })).toBeNull();
      expect(pageLoginConfig({ ...PAGE, META_APP_ID: 'abc' })).toBeNull();
      expect(pageLoginConfig({ ...PAGE, META_APP_SECRET: '' })).toBeNull();
      expect(pageLoginConfig({ ...PAGE, INSTAGRAM_ENABLED: 'false' })).toBeNull();
      expect(pageLoginConfig({ ...PAGE, INSTAGRAM_APP_ID: '' })).toBeNull();
    });

    it('builds the redirect URI from APP_URL or an override, and takes the public app id as a fallback', () => {
      expect(pageLoginConfig(PAGE)).toEqual({
        appId: '9876543210', appSecret: 'test-only-meta-secret',
        redirectUri: 'https://app.example.test/api/instagram/page-login/callback',
      });
      expect(pageLoginConfig({ ...PAGE, INSTAGRAM_PAGE_LOGIN_REDIRECT_URI: 'https://other.example.test/cb' })!.redirectUri)
        .toBe('https://other.example.test/cb');
      expect(pageLoginConfig({ ...PAGE, META_APP_ID: '', NEXT_PUBLIC_META_APP_ID: '55' })!.appId).toBe('55');
      expect(pageLoginConfig({ ...PAGE, INSTAGRAM_PAGE_LOGIN_REDIRECT_URI: 'javascript:1' })).toBeNull();
    });

    it('tells the browser whether it is available, never a secret', () => {
      const status = instagramStatus(PAGE);
      expect(status).toMatchObject({ enabled: true, pageLoginAvailable: true });
      expect(JSON.stringify(status)).not.toContain('test-only-meta-secret');
    });
  });

  it('lists the scopes a feature lacks', () => {
    expect(missingScopes(['instagram_business_basic', 'instagram_business_manage_messages'], 'dm')).toEqual([]);
    expect(missingScopes(['instagram_business_basic', 'instagram_business_manage_messages'], 'comments'))
      .toEqual(['instagram_business_manage_comments']);
    expect(missingScopes([], 'dm')).toEqual(['instagram_business_basic', 'instagram_business_manage_messages']);
  });
});

describe('scheduled Instagram automations (Stage 5)', () => {
  it('stays off unless both INSTAGRAM_ENABLED and INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED are "true"', () => {
    expect(instagramScheduledAutomationsEnabled({})).toBe(false);
    expect(instagramScheduledAutomationsEnabled({ INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED: 'true' })).toBe(false);
    expect(instagramScheduledAutomationsEnabled({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED: '1' })).toBe(false);
    expect(instagramScheduledAutomationsEnabled({ INSTAGRAM_ENABLED: 'true', INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED: ' true ' })).toBe(true);
  });
});
