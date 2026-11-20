// Every sidebar section and tab must open a real page (a tab without a page sends members to a
// 404), and every page must sit in a section, so the sidebar and the breadcrumb always know where it is.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeTab, buildSections, sectionFor } from './sections';

const APP = path.join(process.cwd(), 'src', 'app', '(dashboard)');

function hasPage(href: string): boolean {
  const route = href.split(/[?#]/)[0].replace(/^\//, '');
  const dir = path.join(APP, ...route.split('/'));
  return ['page.tsx', 'page.ts'].some((file) => fs.existsSync(path.join(dir, file)));
}

/** Every page's URL, a dynamic segment ([id]) filled with a sample value. */
function allRoutes(dir = APP, prefix = ''): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^page\.tsx?$/.test(entry.name)) routes.push(prefix || '/');
    if (!entry.isDirectory()) continue;
    // Route groups ((name)) add no segment.
    const segment = /^\(.*\)$/.test(entry.name) ? '' : `/${entry.name.replace(/^\[.*\]$/, 'x1')}`;
    routes.push(...allRoutes(path.join(dir, entry.name), prefix + segment));
  }
  return routes;
}

// Pages that sit outside every section on purpose.
const OUTSIDE = ['/notifications'];

const EXPECTED: Record<string, string> = {
  '/dashboard': 'home',
  '/pipelines': 'sales',
  '/appointments': 'sales',
  '/commerce/orders': 'sales',
  '/commerce/orders/x1': 'sales',
  '/commerce/orders/counter': 'sales',
  '/commerce/payments': 'sales',
  '/commerce/catalogue': 'products',
  '/commerce/catalogue/x1': 'products',
  '/commerce/products': 'products',
  '/commerce/store': 'store',
  '/commerce/store/editor': 'store',
  '/commerce/reviews': 'store',
  '/commerce/settings': 'store',
  '/commerce/insights': 'store',
  '/analytics': 'analytics',
  '/analytics/campaigns': 'analytics',
  '/reports/shared/x1': 'analytics',
  '/contacts/x1': 'contacts',
  '/broadcasts/x1': 'campaigns',
  '/forms/x1': 'campaigns',
  '/flows/x1/runs/x1': 'automation',
  '/instagram/sequences/x1': 'automation',
  '/settings/audit-log': 'settings',
};

describe('navigation sections', () => {
  it('link only to pages that exist', () => {
    for (const enabled of [['whatsapp'], ['instagram'], ['whatsapp', 'instagram']] as const) {
      for (const section of buildSections([...enabled])) {
        for (const href of [section.href, ...section.tabs.map((tab) => tab.href)])
          expect(hasPage(href), `${section.id}: ${href}`).toBe(true);
      }
    }
  });

  it('place every page in a section (and a tab, when the section has tabs)', () => {
    const sections = buildSections(['whatsapp', 'instagram']);
    const routes = allRoutes();
    expect(routes.length).toBeGreaterThan(50);
    for (const route of routes) {
      const section = sectionFor(route, sections);
      if (OUTSIDE.includes(route)) {
        expect(section, route).toBeNull();
        continue;
      }
      expect(section, route).not.toBeNull();
      if (section!.tabs.length) expect(activeTab(route, section!), route).not.toBeNull();
      if (route in EXPECTED) expect(section!.id, route).toBe(EXPECTED[route]);
    }
    for (const route of Object.keys(EXPECTED)) expect(routes, route).toContain(route);
  });
});
