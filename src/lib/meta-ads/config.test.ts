import { describe, expect, it } from 'vitest';
import { metaAdsConfig, metaAdsEnabled, metaAdsStatus, missingScopes, REQUIRED_SCOPES } from './config';

const full = {
  META_ADS_ENABLED: 'true',
  META_APP_ID: '123456',
  META_APP_SECRET: 'secret-a,secret-b',
  META_ADS_LOGIN_CONFIG_ID: '987654',
  META_PAGE_WEBHOOK_VERIFY_TOKEN: 'verify-me',
};

describe('meta ads config gate', () => {
  it('is off unless the flag is exactly true', () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes'])
      expect(metaAdsEnabled({ ...full, META_ADS_ENABLED: value })).toBe(false);
    expect(metaAdsEnabled(full)).toBe(true);
    expect(metaAdsEnabled({ ...full, META_ADS_ENABLED: ' true ' })).toBe(true);
  });

  it('returns no config while the flag is off, even when everything else is set', () => {
    expect(metaAdsConfig({ ...full, META_ADS_ENABLED: undefined })).toBeNull();
    expect(metaAdsStatus({ ...full, META_ADS_ENABLED: undefined })).toEqual({ enabled: false, reason: 'flag_off' });
  });

  it('requires the app id, an app secret and the login config id', () => {
    for (const key of ['META_APP_ID', 'META_APP_SECRET', 'META_ADS_LOGIN_CONFIG_ID'] as const) {
      const env = { ...full, [key]: '  ' };
      expect(metaAdsConfig(env), key).toBeNull();
      expect(metaAdsStatus(env), key).toEqual({ enabled: false, reason: 'not_configured' });
    }
  });

  it('uses the primary secret, else the first app secret, and keeps the verify token optional', () => {
    expect(metaAdsConfig(full)).toEqual({ appId: '123456', appSecret: 'secret-a', loginConfigId: '987654', pageWebhookVerifyToken: 'verify-me' });
    expect(metaAdsConfig({ ...full, META_APP_SECRET_PRIMARY: 'primary' })?.appSecret).toBe('primary');
    expect(metaAdsConfig({ ...full, META_PAGE_WEBHOOK_VERIFY_TOKEN: undefined })?.pageWebhookVerifyToken).toBeNull();
  });

  it('never exposes the secret in the browser status', () => {
    const status = metaAdsStatus(full);
    expect(status).toEqual({ enabled: true, appId: '123456', loginConfigId: '987654' });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('lists the scopes a feature still needs', () => {
    expect(missingScopes([], 'insights')).toEqual(['ads_read']);
    expect(missingScopes(['ads_read', 'business_management'], 'insights')).toEqual([]);
    expect(missingScopes(['leads_retrieval', 'pages_manage_ads'], 'leads')).toEqual(['pages_manage_metadata', 'pages_read_engagement']);
    expect(missingScopes([...REQUIRED_SCOPES.capi], 'capi')).toEqual([]);
  });
});
