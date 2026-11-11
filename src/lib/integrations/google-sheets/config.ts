// Google Sheets (Stage 5, 5G) configuration gate. Owner: 5A (this file only;
// the rest of src/lib/integrations/google-sheets/** belongs to 5G).
//
// Nothing calls Google until GOOGLE_SHEETS_ENABLED=true AND the OAuth client id
// and secret are set, and a workspace admin then connected a Google account.
// While off, the `sheets` flow capability is false, so a Google Sheets step
// cannot be published, and the Settings card shows the integration as off.

type Env = Record<string, string | undefined>;

export interface GoogleSheetsConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GoogleSheetsDisabledReason = 'flag_off' | 'not_configured';
export type GoogleSheetsStatus = { enabled: true } | { enabled: false; reason: GoogleSheetsDisabledReason };

/** The only Google hosts the integration may call (5G uses these, never a URL from input). */
export const GOOGLE_SHEETS_HOSTS = {
  oauth: 'https://oauth2.googleapis.com',
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  sheets: 'https://sheets.googleapis.com',
} as const;

/** The narrowest scopes that read and write the sheets a user picks, plus the account email for the card. */
export const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'openid', 'email'] as const;

const trimmed = (value: string | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

export function googleSheetsEnabled(env: Env = process.env): boolean {
  return env.GOOGLE_SHEETS_ENABLED?.trim() === 'true';
}

/** The full config, or null unless the flag is on and every value is set. */
export function googleSheetsConfig(env: Env = process.env): GoogleSheetsConfig | null {
  if (!googleSheetsEnabled(env)) return null;
  const clientId = trimmed(env.GOOGLE_SHEETS_CLIENT_ID);
  const clientSecret = trimmed(env.GOOGLE_SHEETS_CLIENT_SECRET);
  const appUrl = trimmed(env.APP_URL);
  const redirectUri = trimmed(env.GOOGLE_SHEETS_REDIRECT_URI)
    ?? (appUrl ? `${appUrl.replace(/\/+$/, '')}/api/integrations/google-sheets/callback` : null);
  if (!clientId || !clientSecret || !redirectUri || !/^https?:\/\//.test(redirectUri)) return null;
  return { clientId, clientSecret, redirectUri };
}

/** What the browser may know: never the client secret. */
export function googleSheetsStatus(env: Env = process.env): GoogleSheetsStatus {
  if (!googleSheetsEnabled(env)) return { enabled: false, reason: 'flag_off' };
  return googleSheetsConfig(env) ? { enabled: true } : { enabled: false, reason: 'not_configured' };
}
