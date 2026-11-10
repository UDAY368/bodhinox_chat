import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { testDatabase } from './global-setup';

// Phase 5 inbox: internal notes with @mentions, message search, working
// hours and saved views. The conversation and message are seeded straight
// into the test database (WhatsApp is never contacted).

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Matches the English text or, before the Phase 5 translations are merged
 * into messages/*.json, the key path next-intl renders in its place.
 */
const label = (text: string, key: string) => new RegExp(`^(${escape(text)}|${escape(key)})$`);

let conversationId = '';
let needle = '';

test.beforeAll(async () => {
  const { accountA, users, contact, runId } = fixtures();
  needle = `needle${runId}`;
  const db = await testDatabase();
  try {
    // Idempotent so a retried run reuses the same rows.
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2 ORDER BY created_at LIMIT 1',
      [accountA, contact.id],
    );
    conversationId =
      existing.rows[0]?.id ??
      (
        await db.query<{ id: string }>(
          `INSERT INTO conversations(account_id,user_id,contact_id,status,last_message_text,last_message_at)
           VALUES($1,$2,$3,'open',$4,NOW()) RETURNING id`,
          [accountA, users.owner.id, contact.id, `Hello ${needle}`],
        )
      ).rows[0].id;
    await db.query(
      `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text)
       SELECT $1,$2,'customer','text',$3
       WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id=$2 AND content_text=$3)`,
      [accountA, conversationId, `Hello, my order ${needle} has not arrived`],
    );
  } finally {
    await db.end();
  }
});

// Workspace A uses WhatsApp only (Instagram is off in end-to-end runs), so its
// conversations live in the WhatsApp inbox; old /inbox links redirect there.
async function openConversation(page: Page) {
  await page.goto(`/whatsapp/inbox?c=${conversationId}`);
  await expect(page.getByText(`my order ${needle} has not arrived`)).toBeVisible();
}

test.describe('inbox premium', () => {
  test('an agent adds an internal note that mentions a teammate', async ({ page }) => {
    const { users, accountA } = fixtures();
    await login(page, users.agent);
    await openConversation(page);

    await page.getByRole('button', { name: label('Show internal notes', 'Inbox.messageThread.showNotes') }).click();
    const composer = page.getByRole('combobox', { name: label('Internal note', 'Inbox.notes.composerLabel') });
    await composer.click();
    await composer.pressSequentially('Please call back @E2E adm');
    await page.getByRole('option', { name: /E2E admin/ }).click();
    await composer.pressSequentially(' today');
    // The contact sidebar has its own "Add note" (contact notes); use the internal notes panel's.
    const panel = page.locator('aside').filter({ has: composer });
    await panel.getByRole('button', { name: label('Add note', 'Inbox.notes.add') }).click();

    await expect(panel.getByText(/Please call back/)).toBeVisible();
    await expect(panel.getByText(/today/)).toBeVisible();

    // The note mentions the admin, who gets an in-app notification; nothing reaches the contact.
    const db = await testDatabase();
    try {
      await expect
        .poll(async () =>
          (
            await db.query(
              "SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND user_id=$2 AND type='mention'",
              [accountA, users.admin.id],
            )
          ).rows[0].n,
        )
        .toBe(1);
      const sent = await db.query(
        "SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type<>'customer'",
        [conversationId],
      );
      expect(sent.rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  test("a teammate's note appears live in the open notes panel", async ({ page }) => {
    const { users, accountA, runId } = fixtures();
    await login(page, users.agent);
    await openConversation(page);
    await page.getByRole('button', { name: label('Show internal notes', 'Inbox.messageThread.showNotes') }).click();
    const composer = page.getByRole('combobox', { name: label('Internal note', 'Inbox.notes.composerLabel') });
    await expect(composer).toBeVisible();
    const panel = page.locator('aside').filter({ has: composer });

    // Written elsewhere (here: straight into the database as the admin); the
    // conversation_notes outbox event makes the open panel re-read its notes.
    const body = `Live note ${runId}`;
    const db = await testDatabase();
    try {
      await db.query(
        `INSERT INTO conversation_notes(account_id,conversation_id,author_id,body)
         SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM conversation_notes WHERE conversation_id=$2 AND body=$4)`,
        [accountA, conversationId, users.admin.id, body],
      );
    } finally {
      await db.end();
    }
    await expect(panel.getByText(body)).toBeVisible({ timeout: 15_000 });
  });

  test('clicking a mention notification opens its conversation', async ({ page }) => {
    const { users } = fixtures();
    await login(page, users.admin);
    await page.goto('/notifications');
    await page.getByRole('button', { name: /mentioned you in a note/ }).first().click();
    // The notification keeps its /inbox?c= link, which opens in the WhatsApp inbox.
    await expect(page).toHaveURL(new RegExp(`/whatsapp/inbox\\?c=${conversationId}`));
  });

  test('message search finds a message and opens its conversation', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/whatsapp/inbox');
    await page.getByRole('button', { name: label('Search messages', 'InboxSearch.placeholder') }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('searchbox').fill(needle);
    const hit = dialog.getByRole('button', { name: new RegExp(needle) });
    await expect(hit).toBeVisible();
    await hit.click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/whatsapp/inbox\\?c=${conversationId}`));
    await expect(page.locator('[data-message-id]').filter({ hasText: needle })).toBeVisible();
  });

  test('an admin sets working hours', async ({ page }) => {
    const { users, accountA } = fixtures();
    await login(page, users.admin);
    await page.goto('/settings?tab=inbox');

    const card = page.locator('[data-slot="card"]').filter({ has: page.locator('#inbox-timezone') });
    await expect(card.locator('#inbox-timezone')).toBeEditable();
    await card.locator('#inbox-timezone').fill('Asia/Kolkata');
    const monday = card.getByRole('switch', { name: label('Open on Monday', 'Settings.workingHours.openOn') }).first();
    if ((await monday.getAttribute('aria-checked')) !== 'true') await monday.click();
    await card.getByLabel(label('Opens on Monday', 'Settings.workingHours.opensAt')).first().fill('08:00');
    await card.getByLabel(label('Closes on Monday', 'Settings.workingHours.closesAt')).first().fill('18:00');
    await card.getByRole('button', { name: label('Save', 'Settings.workingHours.save') }).click();

    const db = await testDatabase();
    try {
      await expect
        .poll(async () =>
          (
            await db.query(
              "SELECT timezone, working_hours->'mon' AS mon FROM workspace_inbox_settings WHERE account_id=$1",
              [accountA],
            )
          ).rows[0] ?? null,
        )
        .toEqual({ timezone: 'Asia/Kolkata', mon: [{ start: '08:00', end: '18:00' }] });
    } finally {
      await db.end();
    }
  });

  test('a member saves the current inbox filters as a view', async ({ page }) => {
    const { users, runId } = fixtures();
    await login(page, users.agent);
    await page.goto('/whatsapp/inbox?filter=unread');

    const views = page.getByRole('button', { name: label('Views', 'Inbox.savedFilters.views') });
    await views.click();
    await page.getByRole('menuitem', { name: label('Save current view…', 'Inbox.savedFilters.saveCurrent') }).click();
    const dialog = page.getByRole('dialog');
    const name = `Unread ${runId}`;
    await dialog.getByRole('textbox', { name: label('View name', 'Inbox.savedFilters.nameLabel') }).fill(name);
    await dialog.getByRole('button', { name: label('Save', 'Inbox.savedFilters.save') }).click();
    await expect(dialog.getByText(name)).toBeVisible();
    await page.keyboard.press('Escape');

    // The view survives a reload and re-applies its filter from another one,
    // in the WhatsApp inbox it was saved in (here reached through the old URL).
    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/whatsapp\/inbox$/);
    await page.getByRole('button', { name: label('Views', 'Inbox.savedFilters.views') }).click();
    await page.getByRole('menuitem', { name }).click();
    await expect(page).toHaveURL(/\/whatsapp\/inbox\?filter=unread/);

    // The view belongs to WhatsApp, so the stored filters name the channel.
    const db = await testDatabase();
    try {
      const saved = await db.query<{ channel: string | null }>(
        "SELECT filters->>'channel' AS channel FROM saved_filters WHERE name=$1",
        [name],
      );
      expect(saved.rows.map((row) => row.channel)).toEqual(['whatsapp']);
    } finally {
      await db.end();
    }
  });
});
