import { describe, expect, it } from 'vitest';
import { activeTab, breadcrumbFor, buildSections, MAX_TABS, sectionFor, sidebarGroups } from './sections';

const both = buildSections(['whatsapp', 'instagram']);
const section = (path: string) => sectionFor(path, both)?.id ?? null;
const tab = (path: string) => { const s = sectionFor(path, both); return s ? activeTab(path, s)?.href ?? null : null; };
const crumbs = (path: string, sections = both) => breadcrumbFor(path, sections);

describe('sections', () => {
  it('has Home first and Settings last, in sidebar order', () => {
    expect(both.map((s) => s.id)).toEqual(
      ['home', 'inbox', 'contacts', 'automation', 'campaigns', 'ai', 'sales', 'products', 'store', 'analytics', 'settings']);
    expect(both[0]).toMatchObject({ id: 'home', href: '/dashboard', tabs: [] });
  });

  it(`never gives a section more than ${MAX_TABS} tabs, whichever channels are on`, () => {
    for (const enabled of [['whatsapp'], ['instagram'], ['whatsapp', 'instagram']] as const)
      for (const s of buildSections([...enabled])) expect(s.tabs.length, `${enabled}: ${s.id}`).toBeLessThanOrEqual(MAX_TABS);
  });

  it('splits selling into Sales, Products and Store, and gives Analytics its own Overview', () => {
    const tabs = (id: string) => both.find((s) => s.id === id)!.tabs.map((t) => [t.href, t.labelKey]);
    expect(tabs('sales')).toEqual([['/pipelines', 'pipelines'], ['/appointments', 'appointments'], ['/commerce/orders', 'orders'], ['/commerce/payments', 'payments']]);
    expect(tabs('products')).toEqual([['/commerce/catalogue', 'catalogue'], ['/commerce/products', 'whatsappSync']]);
    expect(tabs('store')).toEqual([['/commerce/store', 'onlineStore'], ['/commerce/reviews', 'reviews'], ['/commerce/settings', 'storeSettings'], ['/commerce/insights', 'shopReports']]);
    expect(both.find((s) => s.id === 'analytics')!.href).toBe('/analytics');
    expect(tabs('analytics').map(([, key]) => key)).toEqual(['analyticsOverview', 'analyticsConversations', 'analyticsTeam', 'campaignResults', 'reports']);
  });

  it('leaves Campaigns out without WhatsApp, and Instagram tools out without Instagram', () => {
    expect(buildSections(['instagram']).map((s) => s.id)).not.toContain('campaigns');
    const waOnly = buildSections(['whatsapp']);
    // Rules list with flows and sequences under one Automation tab.
    expect(waOnly.find((s) => s.id === 'automation')!.tabs.map((t) => t.labelKey)).toEqual(['automation']);
    expect(both.find((s) => s.id === 'automation')!.tabs.map((t) => t.labelKey)).toEqual(['automation', 'instagramTools']);
    expect(waOnly.find((s) => s.id === 'inbox')!.href).toBe('/whatsapp/inbox');
  });

  it('groups the sidebar under at most three quiet labels, Settings apart', () => {
    const groups = sidebarGroups(both);
    expect(groups.map((g) => [g.labelKey, g.sections.map((s) => s.id)])).toEqual([
      [null, ['home', 'inbox', 'contacts']],
      ['groupGrow', ['automation', 'campaigns', 'ai']],
      ['groupSell', ['sales', 'products', 'store']],
      ['groupInsights', ['analytics']],
    ]);
    expect(sidebarGroups(buildSections(['instagram']))[1].sections.map((s) => s.id)).toEqual(['automation', 'ai']);
  });

  it('places every existing page in its section', () => {
    expect(section('/dashboard')).toBe('home');
    expect(section('/inbox')).toBe('inbox');
    expect(section('/instagram/inbox')).toBe('inbox');
    expect(section('/contacts/123')).toBe('contacts');
    expect(section('/automation')).toBe('automation');
    expect(section('/whatsapp/flows/abc')).toBe('automation');
    expect(section('/flows/abc')).toBe('automation');
    expect(section('/instagram/comments')).toBe('automation');
    expect(section('/broadcasts/42')).toBe('campaigns');
    expect(section('/ads')).toBe('campaigns');
    expect(section('/commerce/orders')).toBe('sales');
    expect(section('/commerce/orders/counter')).toBe('sales');
    expect(section('/appointments')).toBe('sales');
    expect(section('/commerce/catalogue/9')).toBe('products');
    expect(section('/commerce/products')).toBe('products');
    expect(section('/commerce/store/editor')).toBe('store');
    expect(section('/commerce/settings')).toBe('store');
    expect(section('/agents')).toBe('ai');
    expect(section('/analytics/team')).toBe('analytics');
    expect(section('/reports/shared/x')).toBe('analytics');
    expect(section('/settings')).toBe('settings');
    expect(section('/notifications')).toBeNull();
  });

  it('picks the most specific tab', () => {
    // A rule, a sequence and the Instagram automation rail open from the Automation list.
    expect(tab('/whatsapp/automations/new')).toBe('/automation');
    expect(tab('/instagram/automations')).toBe('/automation');
    expect(tab('/instagram/sequences/9')).toBe('/automation');
    expect(tab('/instagram/basics')).toBe('/automation');
    expect(tab('/instagram/ref-links')).toBe('/instagram/home');
    expect(tab('/whatsapp/flows/abc')).toBe('/automation');
    expect(tab('/commerce/products/9')).toBe('/commerce/products');
    // Contacts: People, Segments, Custom fields in the shared tab bar.
    expect(both.find((s) => s.id === 'contacts')!.tabs.map((t) => t.labelKey)).toEqual(['people', 'segments', 'customFields']);
    expect(tab('/contacts')).toBe('/contacts');
    expect(tab('/contacts/123')).toBe('/contacts');
    expect(tab('/contacts/segments')).toBe('/contacts/segments');
    expect(tab('/contacts/fields')).toBe('/contacts/fields');
    expect(tab('/analytics')).toBe('/analytics');
    expect(tab('/analytics/campaigns')).toBe('/analytics/campaigns');
    expect(tab('/commerce/orders/counter')).toBe('/commerce/orders');
    expect(tab('/dashboard')).toBeNull();
  });
});

describe('breadcrumb', () => {
  it('shows Section › Tab, the tab a link when the page is a record under it', () => {
    expect(crumbs('/commerce/orders/abc')).toEqual([
      { labelKey: 'sales', href: '/pipelines' },
      { labelKey: 'orders', href: '/commerce/orders' },
    ]);
    expect(crumbs('/commerce/reviews')).toEqual([{ labelKey: 'store', href: '/commerce/store' }, { labelKey: 'reviews' }]);
    expect(crumbs('/analytics')).toEqual([{ labelKey: 'analytics', href: '/analytics' }, { labelKey: 'analyticsOverview' }]);
    expect(crumbs('/broadcasts')).toEqual([{ labelKey: 'campaigns', href: '/broadcasts' }, { labelKey: 'broadcasts' }]);
  });

  it('shows just the section for a section without tabs; Contacts shows its People tab', () => {
    expect(crumbs('/dashboard')).toEqual([{ labelKey: 'home' }]);
    expect(crumbs('/contacts')).toEqual([{ labelKey: 'contacts', href: '/contacts' }, { labelKey: 'people' }]);
    expect(crumbs('/contacts/7')).toEqual([{ labelKey: 'contacts', href: '/contacts' }, { labelKey: 'people', href: '/contacts' }]);
    expect(crumbs('/inbox')).toEqual([{ labelKey: 'inbox' }]);
  });

  it('names pages outside every section on their own, and nothing for unknown pages', () => {
    expect(crumbs('/notifications')).toEqual([{ labelKey: 'notifications' }]);
    expect(crumbs('/somewhere-else')).toEqual([]);
  });

  it('does not repeat a tab named like its section, and keeps Instagram tools in the trail', () => {
    expect(crumbs('/automation')).toEqual([{ labelKey: 'automation' }]);
    expect(crumbs('/whatsapp/flows/abc')).toEqual([{ labelKey: 'automation', href: '/automation' }]);
    expect(crumbs('/instagram/home')).toEqual([{ labelKey: 'automation', href: '/automation' }, { labelKey: 'instagramTools' }]);
    expect(crumbs('/instagram/comments')).toEqual([
      { labelKey: 'automation', href: '/automation' },
      { labelKey: 'instagramTools', href: '/instagram/home' },
      { labelKey: 'comments' },
    ]);
    expect(crumbs('/instagram/sequences/9')).toEqual([
      { labelKey: 'automation', href: '/automation' },
      { labelKey: 'sequences', href: '/instagram/sequences' },
    ]);
  });

  it('never returns a link on the current page', () => {
    for (const path of ['/pipelines', '/commerce/catalogue', '/analytics/team', '/settings', '/instagram/insights'])
      expect(crumbs(path).at(-1)!.href, path).toBeUndefined();
  });
});
