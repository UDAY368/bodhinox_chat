import { describe, expect, it } from 'vitest';
import type { WorkspaceChannel, WorkspaceChannels } from '@/lib/channels/workspace';
import {
  addChannelPrompt,
  buildNavigation,
  filterPages,
  getPageGroup,
  getPageTitleKey,
  navigationPages,
} from './page-search-navigation';

const BOTH = ['whatsapp', 'instagram'] as const;
const hrefs = (enabled: Parameters<typeof navigationPages>[0]) => navigationPages(enabled).map((page) => page.href);
const groups = (enabled: Parameters<typeof buildNavigation>[0]) =>
  Object.fromEntries(buildNavigation(enabled).map((group) => [group.id, group.pages.map((page) => page.href)]));

const WHATSAPP_PAGES = ['/whatsapp/automations', '/broadcasts', '/templates', '/forms', '/ads'];
const INSTAGRAM_PAGES = [
  // Stage 5: Instagram opens on its home page.
  '/instagram/home',
  '/instagram/automations', '/instagram/comments',
  '/instagram/conversation-starters', '/instagram/default-reply', '/instagram/quick-automations',
  // Stage 3
  '/instagram/ref-links', '/instagram/menu', '/instagram/insights'];
const WORKSPACE_PAGES = ['/dashboard', '/analytics', '/notifications', '/contacts', '/automation', '/pipelines', '/appointments', '/agents'];

describe('navigation per channel set', () => {
  it('only WhatsApp: one WhatsApp group plus Workspace, led by the WhatsApp inbox', () => {
    expect(groups(['whatsapp'])).toEqual({ workspace: ['/whatsapp/inbox', ...WORKSPACE_PAGES], whatsapp: WHATSAPP_PAGES });
    expect(buildNavigation(['whatsapp'])[0].pages[0]).toMatchObject({ labelKey: 'inbox', unread: 'whatsapp' });
  });

  it('only Instagram: one Instagram group; broadcasts, templates, forms and ads are hidden', () => {
    expect(groups(['instagram'])).toEqual({ workspace: ['/instagram/inbox', ...WORKSPACE_PAGES], instagram: INSTAGRAM_PAGES });
    for (const href of ['/broadcasts', '/templates', '/forms', '/ads', '/inbox'])
      expect(hrefs(['instagram'])).not.toContain(href);
  });

  it('both: two channel groups and one Inbox (every channel) on top of Workspace', () => {
    const nav = buildNavigation(BOTH);
    expect(nav.map((group) => group.id)).toEqual(['workspace', 'whatsapp', 'instagram']);
    expect(nav[0].pages[0]).toMatchObject({ href: '/inbox', labelKey: 'inbox', unread: 'all' });
    expect(groups(BOTH)).toEqual({ workspace: ['/inbox', ...WORKSPACE_PAGES], whatsapp: WHATSAPP_PAGES, instagram: INSTAGRAM_PAGES });
  });

  it('gives only the Inbox entry an unread badge', () => {
    const badges = (enabled: Parameters<typeof navigationPages>[0]) =>
      navigationPages(enabled).filter((page) => page.unread).map((page) => [page.href, page.unread]);
    expect(badges(BOTH)).toEqual([['/inbox', 'all']]);
    expect(badges(['instagram'])).toEqual([['/instagram/inbox', 'instagram']]);
  });

  it('falls back to the no-row default (WhatsApp) while the state is unknown', () => {
    expect(groups(null)).toEqual(groups(['whatsapp']));
    expect(groups(undefined)).toEqual(groups(['whatsapp']));
    expect(groups([])).toEqual(groups(['whatsapp']));
  });

  it('orders channels WhatsApp first whatever order the state lists them in', () => {
    expect(buildNavigation(['instagram', 'whatsapp']).map((group) => group.id)).toEqual(['workspace', 'whatsapp', 'instagram']);
  });

  it('builds channel links only with channelPath: no legacy channel-less URLs and no ?tab=whatsapp', () => {
    for (const href of hrefs(BOTH)) {
      expect(href).not.toMatch(/^\/(flows|automations)(\/|$)/);
      expect(href).not.toContain('tab=whatsapp');
    }
  });

  it('has a sidebar label and a page title in every locale for every destination', async () => {
    for (const locale of ['en', 'es', 'pt', 'ko']) {
      const messages = (await import(`../../../messages/${locale}.json`)).default as Record<string, Record<string, unknown>>;
      const groupsMessages = messages.Sidebar.groups as Record<string, unknown>;
      for (const page of navigationPages(BOTH)) {
        expect(messages.Sidebar[page.labelKey], `${locale} Sidebar.${page.labelKey}`).toBeTypeOf('string');
        expect(messages.Header[page.labelKey], `${locale} Header.${page.labelKey}`).toBeTypeOf('string');
      }
      for (const group of buildNavigation(BOTH))
        expect(groupsMessages[group.id], `${locale} Sidebar.groups.${group.id}`).toBeTypeOf('string');
      // Stage 5 pages reached outside the sidebar still need a title.
      for (const key of ['basics', 'sequences', 'subscription'])
        expect(messages.Header[key], `${locale} Header.${key}`).toBeTypeOf('string');
      for (const key of ['needsAttention', 'addInstagram', 'upgrade'])
        expect(key === 'needsAttention' ? groupsMessages[key] : messages.Sidebar[key], `${locale} ${key}`).toBeTypeOf('string');
    }
  });
});

describe('page search', () => {
  it('lists the same pages as the sidebar, each channel inbox when both are on, plus Commerce and Settings', () => {
    for (const enabled of [['whatsapp'], ['instagram'], BOTH] as const) {
      const sidebar = buildNavigation(enabled).flatMap((group) => group.pages.map((page) => page.href));
      expect(filterPages('', (key) => key, enabled).map((page) => page.href)).toEqual([
        ...sidebar,
        ...(enabled.length > 1 ? ['/whatsapp/inbox', '/instagram/inbox'] : []),
        '/commerce/orders',
        '/commerce/products',
        '/commerce/payments',
        '/settings',
      ]);
    }
  });

  it('filters by channel the same way the sidebar does', () => {
    expect(filterPages('instagram', (key) => key, ['whatsapp'])).toEqual([]);
    expect(filterPages('starters', (key) => key, ['whatsapp'])).toEqual([]);
    expect(filterPages('conversationStarters', (key) => key, ['instagram']).map((page) => page.href)).toEqual(['/instagram/conversation-starters']);
    expect(filterPages('broadcasts', (key) => key, ['instagram'])).toEqual([]);
    expect(filterPages('broadcasts', (key) => key, BOTH).map((page) => page.href)).toEqual(['/broadcasts']);
  });

  it('searches translated labels, channel names and routes without case or whitespace sensitivity', () => {
    const label = (key: string) => (key === 'contacts' ? 'Contactos' : key);
    const groupLabel = (group: string) => (group === 'instagram' ? 'Instagram' : group === 'whatsapp' ? 'WhatsApp' : '');
    expect(filterPages('  CONTACTOS ', label, BOTH).map((page) => page.href)).toEqual(['/contacts']);
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

describe('page titles', () => {
  it('resolves nested and channel routes without confusing unrelated prefixes', () => {
    expect(getPageTitleKey('/agents/123')).toBe('ai');
    expect(getPageTitleKey('/whatsapp/flows/abc')).toBe('automation');
    expect(getPageTitleKey('/instagram/automations/new')).toBe('automations');
    expect(getPageTitleKey('/instagram/inbox')).toBe('inbox');
    expect(getPageTitleKey('/instagram/comments')).toBe('comments');
    expect(getPageTitleKey('/instagram/conversation-starters')).toBe('conversationStarters');
    expect(getPageTitleKey('/instagram/default-reply')).toBe('defaultReply');
    expect(getPageTitleKey('/instagram/quick-automations/new')).toBe('quickAutomations');
    expect(getPageTitleKey('/instagram/ref-links')).toBe('refLinks');
    expect(getPageTitleKey('/instagram/menu')).toBe('menu');
    expect(getPageTitleKey('/instagram/insights/flows')).toBe('insights');
    expect(getPageGroup('/instagram/insights')).toBe('instagram');
    expect(getPageTitleKey('/instagram/menuX')).toBe('dashboard');
    // Stage 5
    expect(getPageTitleKey('/instagram/home')).toBe('home');
    expect(getPageTitleKey('/instagram/basics')).toBe('basics');
    expect(getPageTitleKey('/instagram/sequences/abc')).toBe('sequences');
    expect(getPageTitleKey('/instagram/subscription')).toBe('subscription');
    for (const path of ['/instagram/home', '/instagram/basics', '/instagram/sequences', '/instagram/subscription'])
      expect(getPageGroup(path), path).toBe('instagram');
    expect(getPageTitleKey('/inbox')).toBe('inbox');
    expect(getPageTitleKey('/forms/123')).toBe('forms');
    expect(getPageTitleKey('/analytics')).toBe('analytics');
    expect(getPageTitleKey('/ads')).toBe('ads');
    expect(getPageTitleKey('/appointments')).toBe('appointments');
    expect(getPageTitleKey('/commerce/orders/42')).toBe('orders');
    expect(getPageTitleKey('/commerce')).toBe('dashboard');
    expect(getPageTitleKey('/inbox-archive')).toBe('dashboard');
  });

  it('names the nav group in the breadcrumb: the channel for its sections and tools, else Workspace', () => {
    expect(getPageGroup('/whatsapp/inbox')).toBe('whatsapp');
    expect(getPageGroup('/instagram/flows/abc')).toBe('instagram');
    expect(getPageGroup('/instagram')).toBe('instagram');
    for (const path of ['/broadcasts', '/broadcasts/42', '/forms/1', '/ads']) expect(getPageGroup(path), path).toBe('whatsapp');
    for (const path of ['/instagram/comments', '/instagram/conversation-starters', '/instagram/default-reply', '/instagram/quick-automations'])
      expect(getPageGroup(path), path).toBe('instagram');
    for (const path of ['/dashboard', '/inbox', '/contacts/7', '/settings', '/flows/new', '/automations', '/instagramx', '/unknown'])
      expect(getPageGroup(path), path).toBe('workspace');
  });

  it('keeps titles for the old channel-less URLs', () => {
    expect(getPageTitleKey('/flows/new')).toBe('flows');
    expect(getPageTitleKey('/automations/42/edit')).toBe('automations');
    expect(getPageTitleKey('/broadcasts')).toBe('broadcasts');
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
