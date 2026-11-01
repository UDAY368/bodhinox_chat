import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

async function openContact(page: Page) {
  await page.goto('/contacts');
  await page.getByText(fixtures().contact.name).click();
  return page.getByRole('dialog');
}

test.describe('contact consent', () => {
  test('an agent marks a contact opted out and blocked, and it persists', async ({ page }) => {
    await login(page, fixtures().users.agent);
    let sheet = await openContact(page);
    const optedOut = sheet.getByRole('switch', { name: 'Opted out of marketing' });
    const blocked = sheet.getByRole('switch', { name: 'Blocked' });
    await expect(optedOut).not.toBeChecked();
    await optedOut.click();
    await expect(optedOut).toBeChecked();
    await blocked.click();
    await expect(blocked).toBeChecked();

    await page.reload();
    sheet = await openContact(page);
    await expect(sheet.getByRole('switch', { name: 'Opted out of marketing' })).toBeChecked();
    await expect(sheet.getByRole('switch', { name: 'Blocked' })).toBeChecked();

    await sheet.getByRole('switch', { name: 'Opted out of marketing' }).click();
    await sheet.getByRole('switch', { name: 'Blocked' }).click();
    await expect(sheet.getByRole('switch', { name: 'Blocked' })).not.toBeChecked();
  });

  test('a viewer sees consent but cannot change it', async ({ page }) => {
    await login(page, fixtures().users.viewer);
    const sheet = await openContact(page);
    await expect(sheet.getByRole('switch', { name: 'Opted out of marketing' })).toBeDisabled();
    await expect(sheet.getByRole('switch', { name: 'Blocked' })).toBeDisabled();
  });
});
