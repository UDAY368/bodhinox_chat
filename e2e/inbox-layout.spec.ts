import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { testDatabase } from './global-setup';

// Inbox layout guard: at every common screen size the page never scrolls
// sideways, the chat column keeps a readable width, the header stays on one
// line, and a long link stays inside its bubble. The conversation is seeded
// straight into the test database (WhatsApp is never contacted).

const SIZES = [
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'small-1024', width: 1024, height: 768 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'phone-390', width: 390, height: 844 },
] as const;

/** The narrowest the chat column may get when it shares the screen with the chat list. */
const MIN_THREAD_WIDTH = 480;

let conversationId = '';
let needle = '';

test.beforeAll(async () => {
  const { accountA, users, runId } = fixtures();
  needle = `layout${runId}`;
  const db = await testDatabase();
  try {
    // A contact with a long name, so truncation (not overflow) is what keeps the row and header in place.
    const contact = await db.query<{ id: string }>(
      `INSERT INTO contacts(account_id,user_id,name,phone)
       VALUES($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [accountA, users.owner.id, `Alexandra Konstantinopoulou-Vanderberg ${needle}`, `9199${String(parseInt(runId, 16) % 1e8).padStart(8, '0')}`],
    );
    const contactId =
      contact.rows[0]?.id ??
      (await db.query<{ id: string }>('SELECT id FROM contacts WHERE account_id=$1 AND name LIKE $2 LIMIT 1', [accountA, `%${needle}`])).rows[0].id;
    conversationId =
      (await db.query<{ id: string }>('SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2 LIMIT 1', [accountA, contactId])).rows[0]?.id ??
      (
        await db.query<{ id: string }>(
          `INSERT INTO conversations(account_id,user_id,contact_id,status,last_message_text,last_message_at,assigned_agent_id)
           VALUES($1,$2,$3,'open',$4,NOW(),$5) RETURNING id`,
          [accountA, users.owner.id, contactId, `Long link ${needle}`, users.agent.id],
        )
      ).rows[0].id;
    await db.query(
      `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text)
       SELECT $1,$2,'customer','text',$3
       WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id=$2 AND content_text=$3)`,
      [accountA, conversationId, `Tracking ${needle}: https://example.com/track/${'x'.repeat(180)}?ref=${needle}`],
    );
  } finally {
    await db.end();
  }
});

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

// One sign-in, then every size in turn (each size is its own step in the report).
test('the inbox fits every common screen size', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, fixtures().users.agent);
  for (const size of SIZES) {
    await test.step(size.name, async () => {
      await page.setViewportSize({ width: size.width, height: size.height });

      // The chat list on its own (phones show the list first).
      await page.goto('/whatsapp/inbox');
      await expect(page.getByText(`Konstantinopoulou-Vanderberg ${needle}`).first()).toBeVisible();
      await noSidewaysScroll(page);

      await page.goto(`/whatsapp/inbox?c=${conversationId}`);
      const message = page.getByText(`Tracking ${needle}`);
      await expect(message).toBeVisible();
      await noSidewaysScroll(page);

      const thread = page.locator('[data-thread-channel]');
      const threadBox = (await thread.boundingBox())!;
      if (size.width >= 1024) {
        expect(threadBox.width, 'the chat column is too narrow').toBeGreaterThanOrEqual(MIN_THREAD_WIDTH);
      } else {
        expect(threadBox.width, 'the chat should take the whole width').toBeGreaterThanOrEqual(size.width - 2);
      }

      // The header is one line: Resolve, the assignee and More actions sit level with the name.
      const header = page.locator('.studio-thread-header');
      const headerBox = (await header.boundingBox())!;
      expect(headerBox.height, 'the chat header wrapped').toBeLessThanOrEqual(64);
      const more = header.getByRole('button', { name: 'More actions' });
      await expect(more).toBeVisible();

      // A long link stays inside its bubble and inside the chat column.
      const bubble = (await message.boundingBox())!;
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(threadBox.x + threadBox.width + 1);

      // The composer's text box keeps a usable width.
      const box = (await page.getByPlaceholder('Type a message').boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(Math.min(240, size.width - 160));

      // The contact panel never squeezes the chat: from 1440px it is a side column
      // (open by default, already measured above), below that it slides over the chat.
      if (size.width >= 1440) {
        await expect(page.locator('[data-contact-panel="column"]')).toBeVisible();
      } else {
        await expect(page.locator('[data-contact-panel]')).toHaveCount(0);
        // Tapping the contact in the header opens their details (the panel button shows from medium widths).
        await header.locator('[data-thread-who]').click();
        await expect(page.locator('[data-contact-panel="overlay"]')).toBeVisible();
        await noSidewaysScroll(page);
        expect((await thread.boundingBox())!.width).toBeCloseTo(threadBox.width, 0);
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-contact-panel]')).toHaveCount(0);
      }
    });
  }
});
