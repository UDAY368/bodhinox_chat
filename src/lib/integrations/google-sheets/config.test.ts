import { describe, expect, it } from 'vitest';
import { GOOGLE_SHEETS_HOSTS, googleSheetsConfig, googleSheetsEnabled, googleSheetsStatus } from './config';

const FULL = {
  GOOGLE_SHEETS_ENABLED: 'true',
  GOOGLE_SHEETS_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_SHEETS_CLIENT_SECRET: 'test-only-secret',
  APP_URL: 'https://app.example.test/',
};

describe('Google Sheets config gate (Stage 5)', () => {
  it('is off by default and with any flag value but "true"', () => {
    expect(googleSheetsEnabled({})).toBe(false);
    expect(googleSheetsEnabled({ GOOGLE_SHEETS_ENABLED: '1' })).toBe(false);
    expect(googleSheetsConfig({ ...FULL, GOOGLE_SHEETS_ENABLED: 'false' })).toBeNull();
    expect(googleSheetsStatus({})).toEqual({ enabled: false, reason: 'flag_off' });
  });

  it('needs the client id and secret and an http(s) redirect', () => {
    expect(googleSheetsConfig(FULL)).toEqual({ clientId: FULL.GOOGLE_SHEETS_CLIENT_ID, clientSecret: 'test-only-secret',
      redirectUri: 'https://app.example.test/api/integrations/google-sheets/callback' });
    expect(googleSheetsConfig({ ...FULL, GOOGLE_SHEETS_CLIENT_SECRET: ' ' })).toBeNull();
    expect(googleSheetsConfig({ ...FULL, GOOGLE_SHEETS_CLIENT_ID: undefined })).toBeNull();
    expect(googleSheetsConfig({ ...FULL, APP_URL: undefined })).toBeNull();
    expect(googleSheetsConfig({ ...FULL, GOOGLE_SHEETS_REDIRECT_URI: 'javascript:alert(1)' })).toBeNull();
    expect(googleSheetsStatus({ GOOGLE_SHEETS_ENABLED: 'true' })).toEqual({ enabled: false, reason: 'not_configured' });
  });

  it('tells the browser only whether it is on, never the secret', () => {
    expect(googleSheetsStatus(FULL)).toEqual({ enabled: true });
    expect(JSON.stringify(googleSheetsStatus(FULL))).not.toContain('test-only-secret');
  });

  it('calls fixed Google hosts only', () => {
    for (const host of Object.values(GOOGLE_SHEETS_HOSTS)) expect(host).toMatch(/^https:\/\/[a-z0-9.]+\.(googleapis|google)\.com(\/|$)/);
  });
});
