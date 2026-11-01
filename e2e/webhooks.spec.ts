import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

const panel = (page: import('@playwright/test').Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Webhooks' }) });

test.describe('Settings → API & webhooks', () => {
  test('an admin adds, pauses and deletes a webhook; the secret is shown once', async ({ page }) => {
    const url = `https://example.com/e2e/${fixtures().runId}`;
    await login(page, fixtures().users.admin);
    await page.goto('/settings?tab=api');

    await panel(page).getByRole('button', { name: 'Add webhook' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#webhook-url').fill(url);
    await dialog.getByText('flow.completed', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Add webhook' }).click();

    const secret = dialog.locator('input[readonly]');
    await expect(secret).toHaveValue(/^whsec_/);
    await dialog.getByRole('button', { name: 'Done' }).click();

    const row = panel(page).locator('li').filter({ hasText: url });
    await expect(row).toBeVisible();
    await expect(row.getByText('flow.completed')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('whsec_');

    await row.getByRole('switch').click();
    await expect(row.getByText('Paused')).toBeVisible();

    await row.getByRole('button', { name: 'Delete webhook' }).click();
    await expect(row).toHaveCount(0);
  });

  test('a viewer can see webhooks but not manage them', async ({ page }) => {
    await login(page, fixtures().users.viewer);
    await page.goto('/settings?tab=api');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Add webhook' })).toHaveCount(0);
  });

  test("another workspace never sees this workspace's webhooks", async ({ page }) => {
    const url = `https://example.com/e2e/tenant/${fixtures().runId}`;
    await login(page, fixtures().users.owner);
    await page.goto('/settings?tab=api');
    await panel(page).getByRole('button', { name: 'Add webhook' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#webhook-url').fill(url);
    await dialog.getByText('broadcast.completed', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Add webhook' }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(panel(page).getByText(url)).toBeVisible();

    await page.context().clearCookies();
    await login(page, fixtures().outsider);
    await page.goto('/settings?tab=api');
    await expect(panel(page).getByText('No webhooks yet.')).toBeVisible();
    await expect(page.getByText(url)).toHaveCount(0);
  });
});
