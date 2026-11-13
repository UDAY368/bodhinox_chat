import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test.describe('segments and export', () => {
  test('an agent builds a segment, sees its live count and filters contacts by it', async ({ page }) => {
    const { contact, runId } = fixtures();
    await login(page, fixtures().users.agent);
    // Segments live on their own tab (Contacts > Segments) as cards.
    await page.goto('/contacts/segments');
    await page.getByRole('button', { name: 'New segment' }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(`Consent contacts ${runId}`);
    const row = dialog.getByTestId('segment-condition');
    await row.getByLabel('Field').selectOption('name');
    await row.getByLabel('Value').fill(contact.name);
    await expect(dialog.getByTestId('segment-count')).toHaveText(/1 contacts match · 1 can receive marketing/);
    await dialog.getByRole('button', { name: 'Save segment' }).click();
    await expect(dialog).toBeHidden();

    // The card shows the live count; View people opens the People tab filtered by it.
    const card = page.locator('article').filter({ hasText: `Consent contacts ${runId}` });
    await expect(card.getByText('1', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'View people' }).click();
    await expect(page).toHaveURL(/\/contacts\?segment=/);

    const selector = page.getByLabel('Segment', { exact: true });
    await expect(selector).toHaveValue(/.+/);
    await expect(page.getByRole('cell', { name: contact.name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export segment' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Delete segment' }).click();
    await expect(selector).toHaveValue('');
  });

  test('a viewer cannot create segments', async ({ page }) => {
    await login(page, fixtures().users.viewer);
    await page.goto('/contacts');
    await expect(page.getByLabel('Segment', { exact: true })).toBeVisible();
    await page.goto('/contacts/segments');
    // The app header repeats the page title; the Contacts tabs carry their own h1.
    await expect(page.getByRole('main').getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New segment' })).toHaveCount(0);
  });

  test('an admin exports contacts as CSV', async ({ page }) => {
    await login(page, fixtures().users.admin);
    await page.goto('/contacts');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = fs.readFileSync((await file.path())!, 'utf8');
    expect(csv).toContain('"Name","Phone","Email","Company","Tags"');
    expect(csv).toContain(fixtures().contact.name);
  });
});
