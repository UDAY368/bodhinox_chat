import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test('an agent adds a location question with a reply timeout to a new flow', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(`Location ${fixtures().runId}`);
  await dialog.getByRole('button', { name: 'Create blank flow' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'Ask for location' }).click();
  await page.getByLabel(/^Variable key/).fill('pickup');
  await page.getByText('Timing').click();
  await page.getByLabel('Stop waiting for a reply after (minutes)').fill('30');

  // The timeout adds its own port, and the missing target is a validation error.
  await expect(page.getByText('Timeout', { exact: true }).first()).toBeVisible();
  await page.getByText(/\d+ errors?, \d+ warnings?/).click();
  await expect(page.getByText('Choose a node for the timeout path.')).toBeVisible();
});
