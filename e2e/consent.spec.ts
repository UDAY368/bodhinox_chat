import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { testDatabase } from './global-setup';

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

// The inbox contact panel records WhatsApp opt-in and opt-out through the audited
// consent route; the header chip and the opted-out banner follow straight away.
test.describe('inbox consent', () => {
  let conversationId = '';
  // The fixture contact is shared (segments count it as able to receive marketing), so
  // every test here starts and ends with no consent recorded.
  const clearConsent = async () => {
    const db = await testDatabase();
    try {
      await db.query('UPDATE contacts SET opted_in_at=NULL, opt_in_source=NULL, opted_out_at=NULL, opt_out_source=NULL WHERE id=$1', [fixtures().contact.id]);
    } finally {
      await db.end();
    }
  };
  test.afterEach(clearConsent);
  test.beforeEach(async () => {
    await clearConsent();
    const { accountA, users, contact } = fixtures();
    const db = await testDatabase();
    try {
      const existing = await db.query<{ id: string }>(
        'SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2 ORDER BY created_at LIMIT 1', [accountA, contact.id]);
      conversationId = existing.rows[0]?.id ?? (await db.query<{ id: string }>(
        "INSERT INTO conversations(account_id,user_id,contact_id,status,last_message_text,last_message_at) VALUES($1,$2,$3,'open','Consent check',NOW()) RETURNING id",
        [accountA, users.owner.id, contact.id])).rows[0].id;
    } finally {
      await db.end();
    }
  });

  test('an agent records an opt-in, then an opt-out, from the contact panel', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto(`/whatsapp/inbox?c=${conversationId}`);
    const header = page.locator('.studio-thread-header');
    await header.locator('[data-thread-who]').click();
    const consent = page.locator('[data-consent-section]');
    await expect(consent).toHaveAttribute('data-consent-section', 'none');

    await consent.getByRole('button', { name: 'Record opt-in' }).click();
    await consent.getByRole('button', { name: 'Yes, they agreed' }).click();
    await expect(consent).toHaveAttribute('data-consent-section', 'opted_in');
    await expect(consent.getByText(/recorded by a teammate/)).toBeVisible();

    await consent.getByRole('button', { name: 'Opt out' }).click();
    await expect(consent).toHaveAttribute('data-consent-section', 'opted_out');
    await expect(page.locator('[data-opted-out-banner]')).toBeVisible();

    // It persists: a reload shows the same state from the database.
    await page.reload();
    await expect(page.locator('[data-opted-out-banner]')).toBeVisible();
  });
});
