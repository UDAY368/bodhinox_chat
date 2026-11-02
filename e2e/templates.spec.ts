import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test('an admin starts a template from the library, saves it as a draft, duplicates it and sees its history', async ({ page }) => {
  const name = `order_conf_${fixtures().runId}`;
  await login(page, fixtures().users.admin);
  await page.goto('/settings?tab=templates');

  await page.getByRole('button', { name: 'Start from library' }).click();
  const library = page.getByRole('dialog');
  await library.getByPlaceholder('Search templates').fill('Order confirmation');
  await library.getByRole('button', { name: 'Use the Order confirmation template' }).click();

  // The editor opens prefilled; drafts never reach Meta.
  const editor = page.getByRole('dialog');
  await expect(editor.getByPlaceholder('e.g. order_confirmation')).not.toHaveValue('');
  await editor.getByPlaceholder('e.g. order_confirmation').fill(name);
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved').first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: /Drafts/ }).click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: `Duplicate ${name}`, exact: true }).click();
  await expect(page.getByText(`Draft ${name}_copy created`).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: `Status history of ${name}`, exact: true }).click();
  await expect(page.getByText('Saved as draft').first()).toBeVisible();
});
