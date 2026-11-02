import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test('an admin creates and saves a WhatsApp form; publishing needs a connected number', async ({ page }) => {
  const name = `Demo booking ${fixtures().runId}`;
  await login(page, fixtures().users.admin);
  await page.goto('/forms');
  await page.getByRole('button', { name: /New form|Create your first form/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Form name').fill(name);
  await dialog.getByRole('button', { name: 'Create form' }).click();
  await expect(page).toHaveURL(/\/forms\/[0-9a-f-]{36}/);

  await page.getByLabel('Screen title').first().fill('Book a demo');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Form saved.').first()).toBeVisible();

  // The test workspace has no WhatsApp number, so Meta is never called.
  const publish = page.waitForResponse((r) => r.url().endsWith('/publish') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  expect((await publish).status()).toBe(409);

  await page.goto('/forms');
  await expect(page.getByText(name).first()).toBeVisible();
});

test('a signed-out visitor is sent to login from the forms page', async ({ page }) => {
  await page.goto('/forms');
  await expect(page).toHaveURL(/\/login/);
});
