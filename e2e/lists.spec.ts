import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test.describe('static lists, tag categories and workspace attributes', () => {
  test('an agent creates a list, adds and removes a contact, and deletes the list', async ({ page }) => {
    const { contact, runId } = fixtures();
    await login(page, fixtures().users.agent);
    await page.goto('/contacts');

    await page.getByRole('button', { name: 'New list' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(`Event ${runId}`);
    await dialog.getByRole('button', { name: 'Create list' }).click();
    await expect(dialog).toBeHidden();

    const selector = page.getByLabel('List', { exact: true });
    await expect(selector).toHaveValue(/.+/);
    await expect(page.getByText('No contacts match')).toBeVisible();

    // Add the seeded contact from the full contact view.
    await selector.selectOption('');
    await page.getByLabel(`Select ${contact.name}`).click();
    await page.getByRole('button', { name: 'Add to list' }).click();
    await page.getByRole('menuitem', { name: `Event ${runId}` }).click();
    await expect(page.getByText(`1 added to Event ${runId}`)).toBeVisible();

    await selector.selectOption({ label: `Event ${runId} (1)` });
    await expect(page.getByRole('cell', { name: contact.name, exact: true })).toBeVisible();
    await page.getByLabel(`Select ${contact.name}`).click();
    await page.getByRole('button', { name: 'Remove from list' }).click();
    await expect(page.getByRole('cell', { name: contact.name, exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Delete list' }).click();
    await expect(selector).toHaveValue('');
  });

  test('an admin saves a secret workspace attribute that is never shown again', async ({ page }) => {
    const key = `e2e_${fixtures().runId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 40);
    await login(page, fixtures().users.admin);
    await page.goto('/settings?tab=fields');

    await page.getByLabel('Key', { exact: true }).fill(key);
    await page.getByLabel('Value', { exact: true }).fill('top-secret-value');
    await page.getByText('Secret', { exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const row = page.locator('li').filter({ hasText: `{{workspace.${key}}}` });
    await expect(row.getByText('Hidden')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('top-secret-value');

    await row.getByRole('button', { name: `Delete ${key}` }).click();
    await expect(row).toHaveCount(0);
  });

  test('an agent does not see the workspace attributes card', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/settings?tab=fields');
    await expect(page.getByText('Workspace attributes')).toHaveCount(0);
  });
});

test('an admin sees the workspace plan and usage', async ({ page }) => {
  await login(page, fixtures().users.admin);
  await page.goto('/settings?tab=plan');
  await expect(page.getByTestId('plan-name')).toHaveText('Current plan: Enterprise');
  await expect(page.getByText('Saved segments')).toBeVisible();
  await expect(page.getByText('Scheduled campaigns')).toBeVisible();
});
