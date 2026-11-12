import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

// The app frame is exactly one screen tall and its content area scrolls inside
// it. Nothing on a page may make the browser window itself scroll: that pushes
// the menu and the page up and leaves an empty band below (an absolutely
// positioned element, such as a screen-reader-only label far down a long table,
// used to do it whenever it had no positioned ancestor inside the scroll area).

const PAGES = [
  '/dashboard',
  '/analytics',
  '/contacts',
  '/whatsapp/inbox',
  '/whatsapp/flows',
  '/whatsapp/broadcasts',
  '/whatsapp/templates',
  '/settings',
];

test('no app page scrolls the browser window', async ({ page }) => {
  test.setTimeout(180_000);
  // A short window, so every page's content is taller than the screen.
  await page.setViewportSize({ width: 1280, height: 480 });
  await login(page, fixtures().users.admin);
  for (const path of PAGES) {
    await test.step(path, async () => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      // Scroll the content area to its end, as a reader would.
      await page.evaluate(() => {
        const main = document.querySelector('main');
        if (main) main.scrollTop = main.scrollHeight;
      });
      const overflow = await page.evaluate(() => ({
        y: document.documentElement.scrollHeight - window.innerHeight,
        x: document.documentElement.scrollWidth - window.innerWidth,
      }));
      expect(overflow.y, `${path} makes the window scroll vertically`).toBeLessThanOrEqual(0);
      expect(overflow.x, `${path} makes the window scroll sideways`).toBeLessThanOrEqual(0);
    });
  }
});
