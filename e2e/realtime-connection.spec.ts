import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { testDatabase } from './global-setup';

// One live-update stream per tab: the inbox list, the open chat, notifications and
// presence all subscribe, and the browser holds a single /api/events connection for
// them (src/lib/realtime/client.ts). A message written straight into the test
// database still reaches the open chat through that one stream.

let conversationId = '';
let needle = '';

test.beforeAll(async () => {
  const { accountA, users, runId } = fixtures();
  needle = `live${runId}`;
  const db = await testDatabase();
  try {
    // Idempotent: a retry runs this again in a fresh worker.
    const contact = await db.query<{ id: string }>(
      `INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [accountA, users.owner.id, `Live ${needle}`, `9188${String(parseInt(runId, 16) % 1e8).padStart(8, '0')}`],
    );
    const contactId =
      contact.rows[0]?.id ??
      (await db.query<{ id: string }>('SELECT id FROM contacts WHERE account_id=$1 AND name=$2 LIMIT 1', [accountA, `Live ${needle}`])).rows[0].id;
    conversationId =
      (await db.query<{ id: string }>('SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2 LIMIT 1', [accountA, contactId])).rows[0]?.id ??
      (
        await db.query<{ id: string }>(
          `INSERT INTO conversations(account_id,user_id,contact_id,status,last_message_text,last_message_at,assigned_agent_id)
           VALUES($1,$2,$3,'open',$4,NOW(),$5) RETURNING id`,
          [accountA, users.owner.id, contactId, `Hello ${needle}`, users.agent.id],
        )
      ).rows[0].id;
    await db.query(
      `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text)
       SELECT $1,$2,'customer','text',$3 WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id=$2 AND content_text=$3)`,
      [accountA, conversationId, `Hello ${needle}`],
    );
  } finally {
    await db.end();
  }
});

/** Counts EventSource objects the page opened and how many are still open. */
async function trackStreams(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const all: EventSource[] = [];
    (window as unknown as { __streams: () => { opened: number; open: number; urls: string[] } }).__streams = () => ({
      opened: all.length,
      open: all.filter((s) => s.readyState !== 2).length,
      urls: all.filter((s) => s.readyState !== 2).map((s) => s.url),
    });
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        all.push(this);
      }
    } as typeof EventSource;
  });
}
const streams = (page: Page) =>
  page.evaluate(() => (window as unknown as { __streams: () => { opened: number; open: number; urls: string[] } }).__streams());

for (const size of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`the open inbox holds one live-update stream (${size.name})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    await trackStreams(page);
    await login(page, fixtures().users.agent);
    await page.goto(`/whatsapp/inbox?c=${conversationId}`);
    await expect(page.getByText(`Hello ${needle}`).filter({ visible: true }).first()).toBeVisible();
    // Let every hook mount and the debounced union settle.
    await expect.poll(async () => (await streams(page)).open, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(1500);
    const settledState = await streams(page);
    expect(settledState.open).toBe(1);
    expect(settledState.urls[0]).toContain('/api/events?');

    // A new message reaches the open chat through that single stream.
    const text = `Arrived live ${needle} ${size.name}`;
    const db = await testDatabase();
    try {
      await db.query(
        `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text) VALUES($1,$2,'customer','text',$3)`,
        [fixtures().accountA, conversationId, text],
      );
    } finally {
      await db.end();
    }
    await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    expect((await streams(page)).open).toBe(1);
  });
}
