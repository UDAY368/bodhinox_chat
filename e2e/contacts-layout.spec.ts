import { expect, test, type Page } from '@playwright/test';
import { fixtures, login, settled } from './fixtures';

// The Contacts pages (People, Segments, Custom fields and the full-page
// profile) at desktop, small laptop, tablet and phone widths: nothing scrolls
// sideways and no two visible controls sit on top of each other.

const WIDTHS = [1440, 1024, 768, 390];

/** Pairs of visible controls inside <main> whose boxes overlap (nested ones excepted). */
async function overlappingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return ['no <main>'];
    const els = [...main.querySelectorAll<HTMLElement>('a[href], button, select, input:not([type=hidden]):not([type=checkbox]), textarea, [role=switch]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && !el.closest('[aria-hidden=true]');
      });
    const label = (el: HTMLElement) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`;
    const out: string[] = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i];
        const b = els[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (x > 2 && y > 2) out.push(`${label(a)} overlaps ${label(b)}`);
      }
    }
    return out;
  });
}

async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const page = document.documentElement.scrollWidth - window.innerWidth;
    return Math.max(page, main ? main.scrollWidth - main.clientWidth : 0);
  });
}

test('the Contacts pages fit every width without overlapping controls', async ({ page }) => {
  test.setTimeout(240_000);
  const { contact } = fixtures();
  await login(page, fixtures().users.admin);
  const paths = ['/contacts', '/contacts/segments', '/contacts/fields', `/contacts/${contact.id}`];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await test.step(`${path} at ${width}px`, async () => {
        await page.goto(path);
        await settled(page);
        // The app header repeats the page title as an h1; check the page's own.
        await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
        expect(await sidewaysOverflow(page), `${path} scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
        expect(await overlappingControls(page), `${path} at ${width}px`).toEqual([]);
      });
    }
  }
});

test('narrow screens show the contact number under the name', async ({ page }) => {
  const { contact } = fixtures();
  await login(page, fixtures().users.admin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/contacts');
  await page.getByRole('searchbox').fill(contact.name);
  const row = page.getByRole('row').filter({ hasText: contact.name });
  await expect(row).toBeVisible();
  // The Channels column is hidden; the row itself still names the channel.
  await expect(page.getByRole('columnheader', { name: 'Channels' })).toBeHidden();
  await expect(row.getByText(/^\+?\d[\d\s]+$/).first()).toBeVisible();
});
