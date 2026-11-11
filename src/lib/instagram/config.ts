// Instagram (Phase 11) configuration gate: Instagram API with Instagram Login
// (graph.instagram.com, Instagram User token). Everything that calls Instagram
// stays off until INSTAGRAM_ENABLED=true AND the app id, app secret and webhook
// verify token are set. While off: no Instagram call from a route or a job, no
// Instagram row written, and routes answer the fixed 503 instagram_not_enabled.
// The Human Agent tag has its own flag (default off) until Meta approves it.

type Env = Record<string, string | undefined>;

export interface InstagramConfig {
  /** Instagram app id (OAuth client_id). */
  appId: string;
  /** The first configured Instagram app secret (code exchange). */
  appSecret: string;
  /**
   * Every secret a webhook signature may use, comma-separated: the Instagram app
   * secret(s), then META_APP_SECRET. Both are ours; the live check records which
   * one Meta signs Instagram Login deliveries with.
   */
  webhookSecrets: string;
  webhookVerifyToken: string;
  redirectUri: string;
  /** Meta approved the Human Agent feature (staff replies up to 7 days). */
  humanAgentEnabled: boolean;
  /**
   * The Click-to-Direct 7-day window applies (Stage 3). Off until a live
   * account confirms Meta's rule (INSTAGRAM_CTD_WINDOW_ENABLED=true).
   */
  ctdWindowEnabled: boolean;
}

export type InstagramDisabledReason = 'flag_off' | 'not_configured';

export type InstagramStatus =
  | { enabled: true; appId: string; humanAgentEnabled: boolean }
  | { enabled: false; reason: InstagramDisabledReason };

export const BASIC_SCOPE = 'instagram_business_basic';
export const MESSAGES_SCOPE = 'instagram_business_manage_messages';
export const COMMENTS_SCOPE = 'instagram_business_manage_comments';

/** The permissions each feature needs from the Instagram Login grant. */
export const REQUIRED_SCOPES = {
  dm: [BASIC_SCOPE, MESSAGES_SCOPE],
  comments: [BASIC_SCOPE, COMMENTS_SCOPE],
} as const;
export type InstagramFeature = keyof typeof REQUIRED_SCOPES;

const trimmed = (value: string | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

const secretList = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function instagramEnabled(env: Env = process.env): boolean {
  return env.INSTAGRAM_ENABLED?.trim() === 'true';
}

/** The full config, or null unless the flag is on and every required value is set. */
export function instagramConfig(env: Env = process.env): InstagramConfig | null {
  if (!instagramEnabled(env)) return null;
  const appId = trimmed(env.INSTAGRAM_APP_ID);
  const secrets = secretList(env.INSTAGRAM_APP_SECRET);
  const webhookVerifyToken = trimmed(env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN);
  if (!appId || !/^\d{1,32}$/.test(appId) || secrets.length === 0 || !webhookVerifyToken) return null;
  const appUrl = trimmed(env.APP_URL);
  const redirectUri = trimmed(env.INSTAGRAM_REDIRECT_URI) ?? (appUrl ? `${appUrl.replace(/\/+$/, '')}/api/instagram/callback` : null);
  if (!redirectUri || !/^https?:\/\//.test(redirectUri)) return null;
  return {
    appId,
    appSecret: secrets[0],
    webhookSecrets: [...secrets, ...secretList(env.META_APP_SECRET)].join(','),
    webhookVerifyToken,
    redirectUri,
    humanAgentEnabled: env.INSTAGRAM_HUMAN_AGENT_ENABLED?.trim() === 'true',
    ctdWindowEnabled: env.INSTAGRAM_CTD_WINDOW_ENABLED?.trim() === 'true',
  };
}

/** What the browser may know: never a secret or the verify token. */
export function instagramStatus(env: Env = process.env): InstagramStatus {
  if (!instagramEnabled(env)) return { enabled: false, reason: 'flag_off' };
  const config = instagramConfig(env);
  if (!config) return { enabled: false, reason: 'not_configured' };
  return { enabled: true, appId: config.appId, humanAgentEnabled: config.humanAgentEnabled };
}

/** The scopes a feature needs that the grant lacks (empty when the feature may run). */
export function missingScopes(granted: readonly string[], feature: InstagramFeature): string[] {
  const have = new Set(granted);
  return REQUIRED_SCOPES[feature].filter((scope) => !have.has(scope));
}
