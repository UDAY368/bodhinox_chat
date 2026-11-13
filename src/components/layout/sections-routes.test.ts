// Every sidebar section and tab must open a real page: a tab added to the
// redesigned navigation without a page would send members to a 404.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSections } from './sections';

const APP = path.join(process.cwd(), 'src', 'app', '(dashboard)');

function hasPage(href: string): boolean {
  const route = href.split(/[?#]/)[0].replace(/^\//, '');
  const dir = path.join(APP, ...route.split('/'));
  return ['page.tsx', 'page.ts'].some((file) => fs.existsSync(path.join(dir, file)));
}

describe('navigation sections', () => {
  it('link only to pages that exist', () => {
    for (const enabled of [['whatsapp'], ['instagram'], ['whatsapp', 'instagram']] as const) {
      for (const section of buildSections([...enabled])) {
        for (const href of [section.href, ...section.tabs.map((tab) => tab.href)])
          expect(hasPage(href), `${section.id}: ${href}`).toBe(true);
      }
    }
  });
});
