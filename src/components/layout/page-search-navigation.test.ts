import { describe, expect, it } from 'vitest';
import type { WorkspaceChannel, WorkspaceChannels } from '@/lib/channels/workspace';
import { addChannelPrompt, filterPages, navigationPages } from './page-search-navigation';
import { buildSections } from './sections';

const BOTH = ['whatsapp', 'instagram'] as const;
const hrefs = (enabled: Parameters<typeof navigationPages>[0]) => navigationPages(enabled).map((page) => page.href);

const CONTACTS = ['/contacts', '/contacts/segments', '/contacts/fields'];
const CAMPAIGNS = ['/broadcasts', '/templates', '/ads', '/forms'];
const SELLING = [
  '/agents',
  '/pipelines', '/appointments', '/commerce/orders', '/commerce/payments',
  '/commerce/catalogue', '/commerce/products',
  '/commerce/store', '/commerce/reviews', '/commerce/settings', '/commerce/insights',
  '/analytics', '/analytics/conversations', '/analytics/team', '/analytics/campaigns', '/reports',
  '/settings',
];
const INSTAGRAM_OWN = [
  '/instagram/automations', '/instagram/comments', '/instagram/conversation-starters', '/instagram/default-reply',
  '/instagram/quick-automations', '/instagram/ref-links', '/instagram/menu', '/instagram/insights',
];

describe('navigation per channel set', () => {
  it('only WhatsApp: every section tab, the WhatsApp inbox, Campaigns, then WhatsApp rules and Notifications', () => {
    expect(hrefs(['whatsapp'])).toEqual([
      '/dashboard', '/whatsapp/inbox', ...CONTACTS, '/automation', ...CAMPAIGNS, ...SELLING, '/whatsapp/automations', '/notifications',
    ]);
    expect(navigationPages(['whatsapp'])[1]).toMatchObject({ labelKey: 'inbox', unread: 'whatsapp' });
  });

  it('only Instagram: Instagram tools and pages; broadcasts, templates, forms and ads are hidden', () => {
    expect(hrefs(['instagram'])).toEqual([
      '/dashboard', '/instagram/inbox', ...CONTACTS, '/automation', '/instagram/home', ...SELLING, ...INSTAGRAM_OWN, '/notifications',
    ]);
    for (const href of ['/broadcasts', '/templates', '/forms', '/ads', '/inbox'])
      expect(hrefs(['instagram'])).not.toContain(href);
  });

  it('both: one Inbox for every channel, then each channel inbox for the search', () => {
    expect(hrefs(BOTH)).toEqual([
      '/dashboard', '/inbox', ...CONTACTS, '/automation', '/instagram/home', ...CAMPAIGNS, ...SELLING,
      '/whatsapp/automations', ...INSTAGRAM_OWN, '/whatsapp/inbox', '/instagram/inbox', '/notifications',
    ]);
  });

  it('lists every sidebar section and tab', () => {
    for (const enabled of [['whatsapp'], ['instagram'], BOTH] as const) {
      const listed = hrefs(enabled);
      for (const section of buildSections(enabled))
        for (const href of section.tabs.length ? section.tabs.map((tab) => tab.href) : [section.href])
          expect(listed, href).toContain(href);
    }
  });

  it('keeps the channel on channel pages and the section on tabs', () => {
    const page = (href: string) => navigationPages(BOTH).find((p) => p.href === href);
    expect(page('/broadcasts')).toMatchObject({ group: 'whatsapp', sectionKey: 'campaigns' });
    expect(page('/instagram/home')).toMatchObject({ group: 'instagram', labelKey: 'instagramTools', sectionKey: 'automation' });
    expect(page('/commerce/reviews')).toMatchObject({ group: 'workspace', labelKey: 'reviews', sectionKey: 'store' });
    expect(page('/dashboard')).toMatchObject({ group: 'workspace', labelKey: 'home' });
  });

  it('gives only the Inbox entry an unread badge', () => {
    const badges = (enabled: Parameters<typeof navigationPages>[0]) =>
      navigationPages(enabled).filter((page) => page.unread).map((page) => [page.href, page.unread]);
    expect(badges(BOTH)).toEqual([['/inbox', 'all']]);
    expect(badges(['instagram'])).toEqual([['/instagram/inbox', 'instagram']]);
  });

  it('falls back to the no-row default (WhatsApp) while the state is unknown', () => {
    expect(hrefs(null)).toEqual(hrefs(['whatsapp']));
    expect(hrefs(undefined)).toEqual(hrefs(['whatsapp']));
    expect(hrefs([])).toEqual(hrefs(['whatsapp']));
  });

  it('orders channels WhatsApp first whatever order the state lists them in', () => {
    expect(hrefs(['instagram', 'whatsapp'])).toEqual(hrefs(BOTH));
  });

  it('builds channel links only with channelPath: no legacy channel-less URLs and no ?tab=whatsapp', () => {
    for (const href of hrefs(BOTH)) {
      expect(href).not.toMatch(/^\/(flows|automations)(\/|$)/);
      expect(href).not.toContain('tab=whatsapp');
    }
  });

  it('has a sidebar label in every locale for every destination, section and breadcrumb', async () => {
    for (const locale of ['en', 'es', 'pt', 'ko']) {
      const messages = (await import(`../../../messages/${locale}.json`)).default as Record<string, Record<string, unknown>>;
      const sidebar = messages.Sidebar;
      const groupsMessages = sidebar.groups as Record<string, unknown>;
      for (const page of navigationPages(BOTH)) expect(sidebar[page.labelKey], `${locale} Sidebar.${page.labelKey}`).toBeTypeOf('string');
      for (const section of buildSections(BOTH)) expect(sidebar[section.labelKey], `${locale} Sidebar.${section.labelKey}`).toBeTypeOf('string');
      // Breadcrumb-only pages (Instagram's automation pages), the sidebar's group labels and its extras.
      for (const key of ['basics', 'sequences', 'subscription', 'groupGrow', 'groupSell', 'groupInsights', 'breadcrumb', 'addInstagram', 'upgrade'])
        expect(sidebar[key], `${locale} Sidebar.${key}`).toBeTypeOf('string');
      for (const key of ['whatsapp', 'instagram', 'needsAttention'])
        expect(groupsMessages[key], `${locale} Sidebar.groups.${key}`).toBeTypeOf('string');
    }
  }, 30_000); // Loads four large message files.
});

describe('page search', () => {
  it('filters by channel the same way the sidebar does', () => {
    expect(filterPages('instagram', (key) => key, ['whatsapp'])).toEqual([]);
    expect(filterPages('starters', (key) => key, ['whatsapp'])).toEqual([]);
    expect(filterPages('conversationStarters', (key) => key, ['instagram']).map((page) => page.href)).toEqual(['/instagram/conversation-starters']);
    expect(filterPages('broadcasts', (key) => key, ['instagram'])).toEqual([]);
    expect(filterPages('broadcasts', (key) => key, BOTH).map((page) => page.href)).toEqual(['/broadcasts']);
  });

  it('finds the tabs of a section by its name', () => {
    expect(filterPages('store', (key) => key, BOTH).map((page) => page.href)).toEqual(
      ['/commerce/store', '/commerce/reviews', '/commerce/settings', '/commerce/insights']);
  });

  it('searches translated labels, channel names and routes without case or whitespace sensitivity', () => {
    const label = (key: string) => (key === 'contacts' ? 'Contactos' : key);
    const groupLabel = (group: string) => (group === 'instagram' ? 'Instagram' : group === 'whatsapp' ? 'WhatsApp' : '');
    expect(filterPages('  CONTACTOS ', label, BOTH).map((page) => page.href)).toEqual(CONTACTS);
    expect(filterPages('/agents', label, BOTH).map((page) => page.href)).toEqual(['/agents']);
    expect(filterPages('instagram inbox', label, BOTH, groupLabel).map((page) => page.href)).toEqual(['/instagram/inbox']);
    expect(filterPages('inbox', label, BOTH, groupLabel).map((page) => page.href)).toEqual([
      '/inbox',
      '/whatsapp/inbox',
      '/instagram/inbox',
    ]);
    expect(filterPages('missing page', label, BOTH)).toEqual([]);
  });
});

describe('Add Instagram prompt', () => {
  const channel = (over: Partial<WorkspaceChannel> & Pick<WorkspaceChannel, 'channel'>): WorkspaceChannel => ({
    available: true, unavailableReason: null, enabled: true, explicit: false, connection: 'live', state: 'live', ...over,
  });
  const workspace = (instagram: Partial<WorkspaceChannel>): WorkspaceChannels => ({
    channels: { whatsapp: channel({ channel: 'whatsapp' }), instagram: channel({ channel: 'instagram', ...instagram }) },
    enabled: instagram.enabled === false ? ['whatsapp'] : ['whatsapp', 'instagram'],
    chosen: false,
  });
  const off = { enabled: false, connection: 'none' as const, state: 'off' as const };

  it('shows admins of a WhatsApp-only workspace a link to add Instagram', () => {
    expect(addChannelPrompt(workspace(off), true)).toEqual({ channel: 'instagram', upgrade: false });
  });

  it('marks it Upgrade when the plan is the blocker', () => {
    expect(addChannelPrompt(workspace({ ...off, available: false, unavailableReason: 'plan', state: 'unavailable' }), true))
      .toEqual({ channel: 'instagram', upgrade: true });
  });

  it('hides it from non-admins, while loading, when the platform is off, and once Instagram is on', () => {
    expect(addChannelPrompt(workspace(off), false)).toBeNull();
    expect(addChannelPrompt(null, true)).toBeNull();
    expect(addChannelPrompt(workspace({ ...off, available: false, unavailableReason: 'platform_off', state: 'unavailable' }), true)).toBeNull();
    expect(addChannelPrompt(workspace({}), true)).toBeNull();
  });
});
