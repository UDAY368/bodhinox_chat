// The public pages: `/` still sends anyone with a session cookie to /dashboard and
// renders the landing page otherwise; the help and legal Markdown renders safely
// (no raw HTML, only safe links) and every help section and legal page exists.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cookies: new Set<string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ has: (name: string) => state.cookies.has(name) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => Object.assign((key: string) => `${ns}.${key}`, { rich: (key: string) => `${ns}.${key}` }),
}));

import RootPage from '../page';
import { cookieNames } from '@/lib/auth/cookies';
import { HELP_SECTIONS } from '@/components/help/help-link';
import { Landing } from './landing';
import { Markdown, readContent, safeHref, slugify } from './markdown';

describe('the root page', () => {
  beforeEach(() => state.cookies.clear());

  it('redirects a signed-in visitor (access or refresh cookie) to the dashboard', async () => {
    state.cookies.add(cookieNames().access);
    await expect(RootPage()).rejects.toThrow('REDIRECT:/dashboard');
    state.cookies.clear();
    state.cookies.add(cookieNames().refresh);
    await expect(RootPage()).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('renders the landing page for a signed-out visitor', async () => {
    const page = await RootPage();
    expect(page).toBeTruthy();
    const html = renderToStaticMarkup(await Landing());
    expect(html).toContain('Marketing.landing.headline');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/pricing"');
  });
});

describe('markdown', () => {
  it('allows only safe link targets', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('mailto:help@example.com')).toBe('mailto:help@example.com');
    expect(safeHref('/help#billing')).toBe('/help#billing');
    expect(safeHref('#top')).toBe('#top');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('integrations/guide.md')).toBeNull();
  });

  it('renders headings, lists, tables and inline marks without raw HTML', () => {
    const html = renderToStaticMarkup(
      <Markdown
        idPrefix="x-"
        source={[
          '# Title',
          '',
          'Text with **bold**, `code`, a [link](https://example.com) and [repo doc](docs/a.md).',
          '',
          '- one',
          '- two',
          '',
          '| A | B |',
          '| --- | --- |',
          '| 1 | <script>alert(1)</script> |',
        ].join('\n')}
      />,
    );
    expect(html).toContain('<h2 id="x-title"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('docs/a.md"');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<table');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('slugifies headings', () => {
    expect(slugify('9b. Appointments & booking pages')).toBe('9b-appointments-booking-pages');
  });

  it('has a file for every help section and legal page, each starting with a heading', () => {
    for (const id of HELP_SECTIONS) expect(readContent('help', id)).toMatch(/^# \S/);
    for (const name of ['privacy', 'terms', 'data-deletion']) {
      expect(existsSync(join(process.cwd(), 'content', 'legal', `${name}.md`))).toBe(true);
      const text = readContent('legal', name);
      expect(text).toMatch(/^# \S/);
      // Final text: no draft notice or operator placeholders, and a reachable contact.
      expect(text).not.toMatch(/DRAFT|placeholder|to be completed/i);
      expect(text).toContain('](/contact)');
    }
    expect(() => readContent('help', '../secrets')).toThrow('Invalid content name');
  });
});
