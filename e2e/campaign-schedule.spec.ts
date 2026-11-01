import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test('an agent schedules a campaign, sees when it will start and cancels it', async ({ page }) => {
  const name = `Scheduled ${fixtures().runId}`;
  await login(page, fixtures().users.agent);
  await page.goto('/broadcasts/new');

  await page.getByRole('button', { name: /e2e_template/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: /All Contacts/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByPlaceholder('e.g., Summer Promo').fill(name);
  await page.getByText('Schedule for later').click();
  // Tomorrow at 10:00 in the browser's time zone.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const local = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T10:00`;
  await page.getByLabel('Send at').fill(local);
  await page.getByRole('button', { name: 'Schedule Broadcast' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Schedule Broadcast' }).click();

  await expect(page).toHaveURL(/\/broadcasts\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^Scheduled for /)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Scheduled for /)).toHaveCount(0);
});

test('the campaign list filters by status tab and name search', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await page.goto('/broadcasts');
  await page.getByRole('tab', { name: 'Cancelled' }).click();
  await page.getByLabel('Search campaigns').fill(`Scheduled ${fixtures().runId}`);
  await expect(page.getByRole('cell', { name: `Scheduled ${fixtures().runId}` })).toBeVisible();
  await page.getByRole('tab', { name: 'Sent' }).click();
  await expect(page.getByText('No campaigns match.')).toBeVisible();
});

test('an agent creates an API campaign and sees how to add recipients', async ({ page }) => {
  const name = `API ${fixtures().runId}`;
  await login(page, fixtures().users.agent);
  await page.goto('/broadcasts');
  await page.getByRole('button', { name: 'New API campaign' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Template').selectOption({ label: 'e2e_template (en_US)' });
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Add recipients through the API')).toBeVisible();
  await expect(page.getByText(/\/api\/v1\/broadcasts\/[0-9a-f-]{36}\/recipients/)).toBeVisible();
});
