import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { testDatabase } from './global-setup';

// Stage 1 channel inboxes. Workspace A has no workspace_channels rows and
// local/CI runs leave INSTAGRAM_ENABLED unset, so A uses WhatsApp only: the
// old /inbox URLs land in the WhatsApp inbox, which lists WhatsApp
// conversations with no channel filter, and the Instagram inbox explains
// that Instagram is not available instead of listing anything.

let conversationId = '';

test.beforeAll(async () => {
  const { accountA, users, contact, runId } = fixtures();
  const preview = `Channel inbox ${runId}`;
  const db = await testDatabase();
  try {
    // The contact's WhatsApp conversation, shared with other specs: a unique
    // key allows one per contact and number, so a parallel insert is a no-op.
    await db.query(
      `INSERT INTO conversations(account_id,user_id,contact_id,status,last_message_text,last_message_at)
       VALUES($1,$2,$3,'open',$4,NOW()) ON CONFLICT DO NOTHING`,
      [accountA, users.owner.id, contact.id, preview],
    );
    const row = await db.query<{ id: string }>(
      "SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2 AND channel='whatsapp' ORDER BY created_at LIMIT 1",
      [accountA, contact.id],
    );
    conversationId = row.rows[0].id;
  } finally {
    await db.end();
  }
});

test.describe('channel inboxes', () => {
  test('the old /inbox URL opens the WhatsApp inbox and keeps its filter', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/inbox?filter=unassigned');
    await expect(page).toHaveURL(/\/whatsapp\/inbox\?filter=unassigned$/);
    await expect(page.locator('[data-inbox-scope="whatsapp"]')).toBeVisible();
    await expect(page.getByText(fixtures().contact.name).first()).toBeVisible();
  });

  test('an old /inbox?c= link opens its conversation in the WhatsApp inbox', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto(`/inbox?c=${conversationId}`);
    await expect(page).toHaveURL(new RegExp(`/whatsapp/inbox\\?c=${conversationId}$`));
    // The linked conversation is the selected row.
    await expect(page.locator('[aria-current="true"]')).toContainText(fixtures().contact.name);
    // A reload keeps the canonical URL and the conversation open.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/whatsapp/inbox\\?c=${conversationId}$`));
    await expect(page.locator('[aria-current="true"]')).toContainText(fixtures().contact.name);
  });

  test('the WhatsApp inbox has no channel filter and no Instagram banner', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/whatsapp/inbox');
    await expect(page.getByText(fixtures().contact.name).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Channel:/ })).toHaveCount(0);
    await expect(page.getByText('All channels')).toHaveCount(0);
    await expect(page.locator('[data-instagram-banner]')).toHaveCount(0);
    await expect(page.getByText('Instagram needs reconnecting')).toHaveCount(0);
  });

  test('the Instagram inbox explains Instagram is not available and lists nothing', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/instagram/inbox');
    await expect(page).toHaveURL(/\/instagram\/inbox$/);
    await expect(page.locator('[data-channel-gate="unavailable"]')).toBeVisible();
    await expect(page.getByText("Instagram isn't available yet")).toBeVisible();
    await expect(page.locator('[data-inbox-scope]')).toHaveCount(0);
    await expect(page.getByText(fixtures().contact.name)).toHaveCount(0);
  });

  test('a WhatsApp conversation linked from the Instagram inbox opens in the WhatsApp inbox', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto(`/instagram/inbox?c=${conversationId}`);
    await expect(page).toHaveURL(new RegExp(`/whatsapp/inbox\\?c=${conversationId}$`));
    await expect(page.locator('[aria-current="true"]')).toContainText(fixtures().contact.name);
  });
});
