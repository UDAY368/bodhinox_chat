/**
 * A static index of the settings: every section and the individual settings
 * people look for, with English titles, search keywords and a link. The
 * settings search box filters it in the browser; it is a plain list so the
 * app-wide search can reuse it. On-screen titles come from the
 * SettingsSearch.entries.<id> messages (the `title` here is the English one).
 *
 * `section` is the settings `?tab=` the entry opens ('ai' is the admin-only AI
 * assistant section); `anchor` is the element id scrolled to inside it. An
 * entry with no section links to a settings screen outside Settings (`href`):
 * the AI page's setup, store settings, booking settings, custom fields. A
 * section that lives on its own page (Templates) links there.
 */
import { SECTION_META, type SettingsSection } from '@/components/settings/settings-sections';

/** A settings `?tab=`: the shared sections plus the admin-only AI assistant and Needs review. */
export type SettingsIndexSection = SettingsSection | 'ai' | 'needs-review';

export interface SettingsIndexEntry {
  id: string;
  title: string;
  keywords: readonly string[];
  href: string;
  section?: SettingsIndexSection;
  anchor?: string;
  /** A whole section, or one setting inside a section. */
  kind: 'section' | 'setting';
  /** Only listed for members who can edit settings, or manage members. The screen itself still checks. */
  requires?: 'edit-settings' | 'manage-members';
}

const tab = (section: SettingsIndexSection, anchor?: string) => `/settings?tab=${section}${anchor ? `#${anchor}` : ''}`;

/** A section's own page when it moved out of Settings, else its `?tab=`. */
const sectionHref = (id: SettingsIndexSection) => (id in SECTION_META ? SECTION_META[id as SettingsSection].href : undefined) ?? tab(id);

function section(id: SettingsIndexSection, title: string, keywords: string[], requires?: SettingsIndexEntry['requires']): SettingsIndexEntry {
  return { id, title, keywords, href: sectionHref(id), section: id, kind: 'section', ...(requires ? { requires } : {}) };
}

/** A settings screen outside Settings. */
function screen(id: string, title: string, href: string, keywords: string[], requires?: SettingsIndexEntry['requires']): SettingsIndexEntry {
  return { id, title, keywords, href, kind: 'setting', ...(requires ? { requires } : {}) };
}

function setting(id: string, title: string, section: SettingsIndexSection, keywords: string[], anchor?: string): SettingsIndexEntry {
  return { id, title, keywords, href: tab(section, anchor), section, anchor, kind: 'setting' };
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  section('overview', 'Overview', ['setup', 'status', 'checklist']),
  section('profile', 'Your profile', ['name', 'avatar', 'photo', 'me']),
  setting('language', 'Language', 'profile', ['locale', 'translation', 'english', 'spanish', 'korean', 'portuguese', 'email language']),
  section('security', 'Login & security', ['password', 'two-factor', '2fa', 'mfa', 'sessions', 'devices', 'email address']),
  setting('password', 'Change password', 'security', ['password', 'reset', 'login']),
  setting('two-factor', 'Two-factor authentication', 'security', ['2fa', 'mfa', 'authenticator', 'code']),
  section('notifications', 'Notifications', ['alerts', 'email digest', 'push', 'browser', 'bell']),
  setting('quiet-hours', 'Quiet hours', 'notifications', ['do not disturb', 'dnd', 'night', 'mute']),
  section('appearance', 'Appearance', ['theme', 'dark mode', 'light mode', 'colors']),
  section('privacy', 'Privacy & access', ['mask phone numbers', 'data', 'export', 'delete', 'gdpr']),
  section('workspace', 'Workspace', ['name', 'time zone', 'timezone', 'default language', 'business']),
  setting('workspace-language', 'Default language', 'workspace', ['locale', 'language', 'team language']),
  setting('time-zone', 'Time zone', 'workspace', ['timezone', 'clock', 'region']),
  section('channels', 'Channels', ['whatsapp', 'instagram', 'connect']),
  section('whatsapp', 'WhatsApp', ['phone number', 'waba', 'meta', 'business account', 'cloud api']),
  setting('whatsapp-numbers', 'Phone numbers', 'whatsapp', ['number', 'sender', 'phone', 'display name']),
  section('instagram', 'Instagram', ['dm', 'comments', 'meta', 'ig']),
  section('members', 'Team members', ['users', 'invite', 'roles', 'admin', 'agent', 'seats', 'teams']),
  setting('invite', 'Invite a teammate', 'members', ['add user', 'invite link', 'staff']),
  section('inbox', 'Inbox', ['conversations', 'chat', 'auto close', 'signature']),
  setting('working-hours', 'Working hours', 'inbox', ['business hours', 'office hours', 'schedule', 'open', 'closed'], 'working-hours'),
  setting('away-message', 'Away message', 'inbox', ['out of office', 'after hours', 'auto reply', 'closed message'], 'working-hours'),
  setting('routing', 'Routing rules', 'inbox', ['assign', 'round robin', 'distribution', 'route'], 'routing'),
  setting('automation-pause', 'Pause automations', 'inbox', ['bot', 'pause', 'human takeover'], 'automation-pause'),
  setting('assignment', 'Assignment mode', 'inbox', ['assign', 'auto assign', 'manual'], 'assignment'),
  setting('visibility', 'Agent visibility', 'inbox', ['see all chats', 'own chats', 'privacy'], 'visibility'),
  section('media', 'Media library', ['images', 'files', 'uploads', 'pictures', 'video']),
  section('templates', 'Templates', ['message templates', 'hsm', 'approval', 'whatsapp templates']),
  section('quick-replies', 'Quick replies', ['canned responses', 'saved replies', 'shortcuts', 'snippets']),
  section('fields', 'Fields & tags', ['custom fields', 'tags', 'labels', 'attributes']),
  section('conversion-events', 'Conversion events', ['goals', 'tracking', 'flows', 'purchase']),
  section('deals', 'Deals & currency', ['pipeline', 'currency', 'money', 'sales']),
  screen('contact-fields', 'Contact fields', '/contacts/fields', ['custom fields', 'contacts', 'attributes', 'properties']),
  section('ai', 'AI assistant', ['ai', 'bot', 'gpt', 'claude', 'gemini', 'auto reply', 'provider', 'api key'], 'edit-settings'),
  screen('ai-setup', 'AI provider and model', '/agents?tab=setup', ['openai', 'anthropic', 'gemini', 'api key', 'model', 'test connection'], 'edit-settings'),
  screen('ai-knowledge', 'AI knowledge', '/agents?tab=knowledge', ['knowledge base', 'faq', 'documents', 'website', 'sources'], 'edit-settings'),
  screen('ai-usage', 'AI usage', '/agents?tab=activity', ['tokens', 'budget', 'cost', 'activity', 'learnings', 'quality'], 'edit-settings'),
  screen('store-settings', 'Store settings', '/commerce/settings', ['shop', 'store', 'checkout', 'shipping', 'delivery', 'tax', 'commerce']),
  screen('booking-settings', 'Booking settings', '/appointments?tab=settings', ['appointments', 'booking link', 'calendar', 'reminders', 'availability']),
  section('integrations', 'Integrations', ['apps', 'connect', 'shopify', 'woocommerce', 'zoom', 'google']),
  section('payments', 'Payments', ['razorpay', 'stripe', 'upi', 'payment links']),
  section('connections', 'Meetings & shipping', ['zoom', 'google meet', 'shiprocket', 'delivery', 'courier']),
  section('ads', 'Ads', ['meta ads', 'facebook ads', 'ad account', 'click to whatsapp']),
  section('api', 'API & webhooks', ['api keys', 'developer', 'webhook', 'integration', 'token']),
  setting('webhooks', 'Webhooks', 'api', ['callback', 'events', 'endpoint'], 'webhooks'),
  section('plan', 'Plan & usage', ['billing', 'subscription', 'invoice', 'upgrade', 'limits', 'rate card']),
  section('audit-log', 'Audit log', ['history', 'security', 'who changed', 'events'], 'manage-members'),
  section('needs-review', 'Needs review', ['uncertain', 'failed sends', 'reconcile', 'outcome unknown', 'check sends'], 'manage-members'),
];

/**
 * The "Related" links a section shows: entry ids from SETTINGS_INDEX. Sections
 * not listed show none.
 */
export const RELATED_SETTINGS: Partial<Record<SettingsIndexSection, readonly string[]>> = {
  overview: ['workspace', 'channels', 'members'],
  appearance: ['profile', 'language'],
  instagram: ['channels', 'whatsapp', 'quick-replies'],
  media: ['templates', 'quick-replies'],
  'conversion-events': ['fields', 'deals'],
  payments: ['integrations', 'store-settings', 'plan'],
  connections: ['integrations', 'booking-settings'],
  ads: ['integrations', 'conversion-events'],
  'audit-log': ['members', 'security', 'needs-review'],
  'needs-review': ['audit-log', 'inbox'],
  inbox: ['working-hours', 'away-message', 'routing', 'quick-replies'],
  whatsapp: ['templates', 'whatsapp-numbers', 'quick-replies'],
  channels: ['whatsapp', 'instagram', 'templates'],
  templates: ['whatsapp', 'quick-replies', 'media'],
  'quick-replies': ['inbox', 'templates', 'media'],
  ai: ['ai-knowledge', 'ai-usage', 'ai-setup'],
  members: ['inbox', 'audit-log', 'notifications'],
  notifications: ['quiet-hours', 'profile', 'members'],
  profile: ['language', 'security', 'notifications'],
  workspace: ['working-hours', 'members', 'deals'],
  integrations: ['payments', 'connections', 'api'],
  api: ['webhooks', 'integrations', 'audit-log'],
  plan: ['members', 'payments'],
  fields: ['contact-fields', 'conversion-events', 'deals'],
  deals: ['fields', 'payments'],
  security: ['privacy', 'audit-log'],
  privacy: ['security', 'members'],
};

const byId = new Map(SETTINGS_INDEX.map((entry) => [entry.id, entry]));

/** The related entries for a section, in order, dropping any the viewer cannot open. */
export function relatedSettings(section: SettingsIndexSection, canOpen: (entry: SettingsIndexEntry) => boolean = () => true): SettingsIndexEntry[] {
  return (RELATED_SETTINGS[section] ?? []).map((id) => byId.get(id)).filter((e): e is SettingsIndexEntry => !!e && canOpen(e));
}

const fold = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Entries matching a query, best first: a title that starts with the query,
 * then a title word that does, then a keyword or the title containing it.
 * Every word of the query must match somewhere. `label` gives the on-screen
 * (translated) title so it is searched too.
 */
export function searchSettings(
  query: string,
  options: { entries?: readonly SettingsIndexEntry[]; label?: (entry: SettingsIndexEntry) => string; limit?: number } = {},
): SettingsIndexEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const { entries = SETTINGS_INDEX, label, limit = 8 } = options;
  const scored: { entry: SettingsIndexEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const titles = [fold(entry.title), ...(label ? [fold(label(entry))] : [])];
    const keywords = entry.keywords.map(fold);
    const phrase = words.join(' ');
    let score = 0;
    for (const word of words) {
      const hit = titles.some((t) => t.includes(word)) || keywords.some((k) => k.includes(word));
      if (!hit) return;
    }
    if (titles.some((t) => t.startsWith(phrase))) score += 100;
    else if (titles.some((t) => t.split(/[\s&/-]+/).some((w) => w.startsWith(words[0])))) score += 50;
    if (keywords.some((k) => k === phrase || k.startsWith(phrase))) score += 20;
    if (entry.kind === 'section') score += 5;
    scored.push({ entry, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map((s) => s.entry);
}
