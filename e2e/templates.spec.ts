import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test('an admin starts a template from the library, saves it as a draft, duplicates it and sees its history', async ({ page }, testInfo) => {
  // A retry gets its own name: the first attempt may already have saved this one.
  const name = `order_conf_${fixtures().runId}_${testInfo.retry}`;
  const dialog = page.getByRole('dialog');
  await login(page, fixtures().users.admin);
  await page.goto('/settings?tab=templates');

  await page.getByRole('button', { name: 'Start from library' }).click();
  await dialog.getByPlaceholder('Search templates').fill('Order confirmation');
  await dialog.getByRole('button', { name: 'Use the Order confirmation template' }).click();

  // The editor opens prefilled; drafts never reach Meta.
  await expect(dialog.getByPlaceholder('e.g. order_confirmation')).not.toHaveValue('');
  await dialog.getByPlaceholder('e.g. order_confirmation').fill(name);
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('tab', { name: /Drafts/ }).click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();

  // Duplicating opens the copy in the editor; wait for it before closing it.
  await page.getByRole('button', { name: `Duplicate ${name}`, exact: true }).click();
  await expect(page.getByText(`Draft ${name}_copy created`).first()).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: `Status history of ${name}`, exact: true }).click();
  await expect(page.getByText('Saved as draft').first()).toBeVisible();
});
