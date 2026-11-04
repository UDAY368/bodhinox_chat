// Zoom meetings (Phase 9, design D1) configuration gate. Owner: T2.
//
// Nothing calls Zoom until ZOOM_ENABLED=true AND the General (OAuth) app's
// client id, client secret and webhook secret token are set, and a workspace
// admin then connected its own Zoom account. Production keeps ZOOM_ENABLED
// unset until Zoom approves the app (design D1a).

type Env = Record<string, string | undefined>;

export interface ZoomConfig {
  clientId: string;
  clientSecret: string;
  webhookSecretToken: string;
}

export type ZoomDisabledReason = 'flag_off' | 'not_configured';
export type ZoomStatus = { enabled: true } | { enabled: false; reason: ZoomDisabledReason };

const trimmed = (value: string | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

export function zoomEnabled(env: Env = process.env): boolean {
  return env.ZOOM_ENABLED?.trim() === 'true';
}

/** The full config, or null unless the flag is on and every value is set. */
export function zoomConfig(env: Env = process.env): ZoomConfig | null {
  if (!zoomEnabled(env)) return null;
  const clientId = trimmed(env.ZOOM_CLIENT_ID);
  const clientSecret = trimmed(env.ZOOM_CLIENT_SECRET);
  const webhookSecretToken = trimmed(env.ZOOM_WEBHOOK_SECRET_TOKEN);
  if (!clientId || !clientSecret || !webhookSecretToken) return null;
  return { clientId, clientSecret, webhookSecretToken };
}

/** What the browser may know: never a secret. */
export function zoomStatus(env: Env = process.env): ZoomStatus {
  if (!zoomEnabled(env)) return { enabled: false, reason: 'flag_off' };
  return zoomConfig(env) ? { enabled: true } : { enabled: false, reason: 'not_configured' };
}
