// The public legal pages: the contact page shows SUPPORT_EMAIL only when it is a
// valid address, and /data-deletion shows the Meta deletion request status for a
// well-formed confirmation code (a malformed one never reaches the database).
// Outside English, help and legal pages say their text is English only.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const find = vi.hoisted(() => vi.fn());
const intl = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => intl.locale,
  getTranslations: async (ns: string) => (key: string, values?: Record<string, string>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('@/lib/meta/data-deletion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/data-deletion')>()),
  findDeletionRequest: find,
}));

import ContactPage from './contact/page';
import DataDeletionPage from './data-deletion/page';
import HelpPage from './help/page';
import PrivacyPage from './privacy/page';
import TermsPage from './terms/page';
import { supportEmail } from './contact-email';

const CODE = 'a'.repeat(48);
const render = async (code?: string | string[]) =>
  renderToStaticMarkup(await DataDeletionPage({ searchParams: Promise.resolve(code === undefined ? {} : { code }) }));

describe('contact page', () => {
  const saved = process.env.SUPPORT_EMAIL;
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = saved;
  });

  it('accepts only a plain address', () => {
    expect(supportEmail({ SUPPORT_EMAIL: ' help@example.in ' })).toBe('help@example.in');
    expect(supportEmail({})).toBeNull();
    expect(supportEmail({ SUPPORT_EMAIL: 'not an email' })).toBeNull();
    expect(supportEmail({ SUPPORT_EMAIL: 'a@b.com"><script>' })).toBeNull();
  });

  it('shows the configured address as a mailto link, or says none is published', async () => {
    process.env.SUPPORT_EMAIL = 'help@example.in';
    let html = renderToStaticMarkup(await ContactPage());
    expect(html).toContain('href="mailto:help@example.in"');
    delete process.env.SUPPORT_EMAIL;
    html = renderToStaticMarkup(await ContactPage());
    expect(html).not.toContain('mailto:');
    expect(html).toContain('Marketing.legal.contactUnset');
  });
});

describe('data deletion page', () => {
  beforeEach(() => { find.mockReset(); find.mockResolvedValue(null); });

  it('explains deletion without a status block when no code is given', async () => {
    const html = await render();
    expect(html).toContain('Data deletion');
    expect(html).not.toContain('deletion-status');
    expect(find).not.toHaveBeenCalled();
  });

  it('shows a completed request with its code and date', async () => {
    find.mockResolvedValue({ status: 'completed', createdAt: new Date('2026-11-10T08:00:00Z') });
    const html = await render(CODE);
    expect(find).toHaveBeenCalledWith(CODE);
    expect(html).toContain('statusCompleted');
    expect(html).toContain(CODE);
    expect(html).toContain('2026-11-10');
  });

  it('reports an unknown, malformed or failing lookup as not found', async () => {
    find.mockResolvedValue(null);
    expect(await render(CODE)).toContain('statusUnknown');
    find.mockReset();
    expect(await render("x' OR 1=1")).toContain('statusUnknown');
    expect(await render([CODE, CODE])).toContain('statusUnknown');
    expect(find).not.toHaveBeenCalled();
  });

  it('shows not found when the lookup fails', async () => {
    find.mockImplementation(async () => { throw new Error('db down'); });
    expect(await render(CODE)).toContain('statusUnknown');
    expect(find).toHaveBeenCalledWith(CODE);
  });
});

describe('English-only notice', () => {
  afterEach(() => { intl.locale = 'en'; });

  it('is absent in English and shown on help, privacy, terms and data deletion elsewhere', async () => {
    const pages = async () => [
      renderToStaticMarkup(await HelpPage()),
      renderToStaticMarkup(await PrivacyPage()),
      renderToStaticMarkup(await TermsPage()),
      await render(),
    ];
    for (const html of await pages()) expect(html).not.toContain('english-only');
    for (const locale of ['es', 'pt', 'ko']) {
      intl.locale = locale;
      for (const html of await pages()) expect(html).toContain('Marketing.help.englishOnly');
    }
  });
});
