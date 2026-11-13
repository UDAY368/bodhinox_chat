import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { testDatabase } from './global-setup';

/** The contacts table row opens the contact's full-page profile. */
async function openContact(page: Page) {
  await page.goto('/contacts');
  await page.getByRole('link', { name: fixtures().contact.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${fixtures().contact.id}`));
  return page.locator('main');
}

test.describe('contact consent', () => {
  test('an agent opts a contact out of WhatsApp and blocks them, and it persists', async ({ page }) => {
    await login(page, fixtures().users.agent);
    let profile = await openContact(page);
    const whatsapp = profile.getByRole('switch', { name: 'WhatsApp messages' });
    await expect(whatsapp).toBeChecked();
    await whatsapp.click();
    await expect(whatsapp).not.toBeChecked();
    await profile.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Block' }).click();
    await expect(profile.getByTestId('contact-blocked-badge')).toBeVisible();

    await page.reload();
    profile = page.locator('main');
    await expect(profile.getByRole('switch', { name: 'WhatsApp messages' })).not.toBeChecked();
    await expect(profile.getByTestId('contact-blocked-badge')).toBeVisible();
    // Both changes are on the timeline.
    await expect(profile.getByText(/Opted out of WhatsApp messages/)).toBeVisible();

    // Turning messages back on asks first; removing only the opt-out records no opt-in.
    await profile.getByRole('switch', { name: 'WhatsApp messages' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Only remove the opt-out' }).click();
    await expect(profile.getByRole('switch', { name: 'WhatsApp messages' })).toBeChecked();
    await profile.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Unblock' }).click();
    await expect(profile.getByTestId('contact-blocked-badge')).toHaveCount(0);
  });

  test('a viewer sees consent but cannot change it', async ({ page }) => {
    await login(page, fixtures().users.viewer);
    const profile = await openContact(page);
    await expect(profile.getByRole('switch', { name: 'WhatsApp messages' })).toBeDisabled();
    await expect(profile.getByRole('button', { name: 'Message', exact: true })).toHaveCount(0);
    await profile.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Block' })).toHaveCount(0);
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
