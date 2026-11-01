/** Plan switches and caps (no imports, so the browser can use it too). */
export const FEATURES = ['campaign_scheduling', 'contact_export', 'api_campaigns', 'click_tracking', 'retargeting', 'workspace_attributes'] as const;
export const LIMITS = ['seats', 'segments', 'lists', 'campaign_recipients', 'active_flows', 'active_automations'] as const;
export type Feature = (typeof FEATURES)[number];
export type LimitKey = (typeof LIMITS)[number];
