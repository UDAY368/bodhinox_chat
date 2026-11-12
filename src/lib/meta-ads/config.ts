// Click-to-WhatsApp ads (Phase 10) configuration gate.
//
// Everything that calls Meta's Marketing, Page or Conversions APIs stays off
// until META_ADS_ENABLED=true AND the app id, an app secret for the code
// exchange and a Facebook Login for Business configuration id are set. Referral
// capture from inbound WhatsApp messages needs none of this and is always on.
import { codeExchangeSecret } from '@/lib/whatsapp/embedded-signup-connect';

type Env = Record<string, string | undefined>;

export interface MetaAdsConfig {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id (sent to the browser through the status route). */
  loginConfigId: string;
  /** Page webhook verify token; null when the leadgen webhook is not configured. */
  pageWebhookVerifyToken: string | null;
}

export type MetaAdsDisabledReason = 'flag_off' | 'not_configured';

export type MetaAdsStatus =
  | { enabled: true; appId: string; loginConfigId: string }
  | { enabled: false; reason: MetaAdsDisabledReason };

/** The permissions each feature needs from the Login for Business grant. */
export const REQUIRED_SCOPES = {
  insights: ['ads_read'],
  leads: ['leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads'],
  capi: ['whatsapp_business_manage_events'],
  // Pause / resume, budgets, end dates and names of existing campaigns, ad sets and ads.
  manage: ['ads_management'],
} as const;
export type MetaAdsFeature = keyof typeof REQUIRED_SCOPES;

const trimmed = (value: string | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

export function metaAdsEnabled(env: Env = process.env): boolean {
  return env.META_ADS_ENABLED?.trim() === 'true';
}

/**
 * Ad management (changing campaigns, ad sets and ads at Meta) ships dark: it
 * needs META_ADS_MANAGE_ENABLED=true on top of the Meta ads config, and stays
 * unset until Meta approves `ads_management` in App Review.
 */
export function metaAdsManageEnabled(env: Env = process.env): boolean {
  return metaAdsConfig(env) !== null && env.META_ADS_MANAGE_ENABLED?.trim() === 'true';
}

/** The full config, or null unless the flag is on and every required value is set. */
export function metaAdsConfig(env: Env = process.env): MetaAdsConfig | null {
  if (!metaAdsEnabled(env)) return null;
  const appId = trimmed(env.META_APP_ID);
  const appSecret = codeExchangeSecret(env);
  const loginConfigId = trimmed(env.META_ADS_LOGIN_CONFIG_ID);
  if (!appId || !appSecret || !loginConfigId) return null;
  return { appId, appSecret, loginConfigId, pageWebhookVerifyToken: trimmed(env.META_PAGE_WEBHOOK_VERIFY_TOKEN) };
}

/** What the browser may know: never the secret. */
export function metaAdsStatus(env: Env = process.env): MetaAdsStatus {
  if (!metaAdsEnabled(env)) return { enabled: false, reason: 'flag_off' };
  const config = metaAdsConfig(env);
  if (!config) return { enabled: false, reason: 'not_configured' };
  return { enabled: true, appId: config.appId, loginConfigId: config.loginConfigId };
}

/** The scopes a feature needs that the grant lacks (empty when the feature may run). */
export function missingScopes(granted: readonly string[], feature: MetaAdsFeature): string[] {
  const have = new Set(granted);
  return REQUIRED_SCOPES[feature].filter((scope) => !have.has(scope));
}
