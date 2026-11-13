import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

// The sidebar has one Inbox entry and one AI entry, and collapses to its icon
// rail on desktop; the choice is remembered in this browser.

const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.QA_SHOTS) await page.screenshot({ path: `${process.env.QA_SHOTS}/${name}.png` });
};

test('one Inbox and one AI entry; the sidebar collapses and stays collapsed', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, fixtures().users.admin);
  await page.goto('/dashboard');
  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'Inbox', exact: true })).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'AI', exact: true })).toBeVisible();
  await shot(page, 'sidebar-expanded');

  const sidebar = page.locator('aside.studio-sidebar');
  const wide = (await sidebar.boundingBox())!.width;
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(wide / 2);
  await shot(page, 'sidebar-collapsed');

  await page.reload();
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'true');
});

test('the AI page opens a tab from its link, including the assistant features', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, fixtures().users.admin);
  await page.goto('/agents?tab=features');
  await expect(page.getByRole('tab', { name: 'Assistant features' })).toHaveAttribute('aria-selected', 'true');
  // The four-tab AI console's features panel: a region with the feature switches.
  const features = page.getByRole('region', { name: 'Assistant features' });
  await expect(features.getByText('Help for your team inside the inbox.', { exact: false })).toBeVisible();
  await expect(features.getByRole('switch', { name: 'Suggested replies' })).toBeVisible();
  await shot(page, 'ai-features');
});
