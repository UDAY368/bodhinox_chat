import { expect, test, type Page, type Route } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Stage 5 (5H): Instagram sequences. Local and CI runs leave INSTAGRAM_ENABLED
// unset, so the real server must refuse the API with the fixed 503 and the page
// must show the channel's "not available" state. The editor journey (create a
// sequence, add two messages, toggle Active) runs against an in-browser stand-in
// for /api/sequences and an Instagram channel marked live, because nothing here
// may reach Instagram; the server rules behind those calls (roles, tenancy, the
// 24-hour window, one send per message) are covered by
// src/lib/sequences/sequences.integration.test.ts.

test.describe('sequences with INSTAGRAM_ENABLED unset', () => {
  test('the API answers instagram_not_enabled and the page explains Instagram is not available', async ({ page }) => {
    await login(page, fixtures().users.agent);
    const list = await page.request.get('/api/sequences');
    expect(list.status()).toBe(503);
    expect(await list.json()).toMatchObject({ code: 'instagram_not_enabled' });
    await page.goto('/instagram/sequences');
    await expect(page.locator('[data-channel-gate="unavailable"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New sequence' })).toHaveCount(0);
  });
});

type Message = {
  id: string; position: number; delay_amount: number; delay_unit: string; active: boolean;
  flow_id: string; flow_name: string; flow_status: string; sent: number; clicks: number; open_rate: null; ctr: null;
};

/** A stand-in for the sequences API (one sequence at most), recording every write. */
async function standIn(page: Page) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  let sequence: { id: string; name: string; status: string; items: Message[] } | null = null;
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const detail = () => sequence && ({
    ...sequence, channel: 'instagram', subscribers: 0, messages: sequence.items.length, sent: 0, clicks: 0, open_rate: null, ctr: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });

  await page.route('**/api/account/channels', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.channels.instagram = {
      ...body.channels.instagram, available: true, unavailableReason: null, enabled: true, explicit: true, connection: 'live', state: 'live',
    };
    body.enabled = ['whatsapp', 'instagram'];
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/api/flows?channel=instagram', (route) => route.fulfill({ json: { flows: [] } }));
  await page.route('**/api/sequences**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()!) : null;
    if (method !== 'GET') writes.push({ method, path, body });
    if (path === '/api/sequences' && method === 'GET')
      return route.fulfill({ json: { sequences: sequence ? [detail()] : [] } });
    if (path === '/api/sequences' && method === 'POST') {
      sequence = { id: id(), name: body.name, status: 'active', items: [] };
      return route.fulfill({ status: 201, json: { sequence: detail() } });
    }
    if (!sequence) return route.fulfill({ status: 404, json: { code: 'notFound' } });
    if (path.endsWith('/subscribers')) return route.fulfill({ json: { subscribers: [] } });
    if (path.endsWith('/messages') && method === 'POST') {
      const position = sequence.items.length;
      sequence.items.push({
        id: id(), position, delay_amount: position === 0 ? 0 : 1, delay_unit: position === 0 ? 'minutes' : 'days', active: true,
        flow_id: id(), flow_name: body.create.name, flow_status: 'draft', sent: 0, clicks: 0, open_rate: null, ctr: null,
      });
      return route.fulfill({ status: 201, json: { sequence: detail() } });
    }
    const messageId = /\/messages\/([^/]+)$/.exec(path)?.[1];
    if (messageId && method === 'PATCH') {
      sequence.items = sequence.items.map((m) => (m.id === messageId ? { ...m, ...body } : m));
      return route.fulfill({ json: { sequence: detail() } });
    }
    return route.fulfill({ json: { sequence: detail() } });
  });
  return writes;
}

test.describe('sequence editor', () => {
  test('creates a sequence, adds two messages and turns one off', async ({ page }) => {
    await login(page, fixtures().users.agent);
    const writes = await standIn(page);
    await page.goto('/instagram/sequences');
    await page.getByRole('button', { name: 'New sequence' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Welcome series');
    await page.getByRole('button', { name: 'Create sequence' }).click();
    await expect(page).toHaveURL(/\/instagram\/sequences\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Welcome series' })).toBeVisible();

    for (const name of ['Day one', 'Day two']) {
      await page.getByRole('button', { name: /Create new/ }).click();
      await page.getByLabel('Name of the new automation').fill(name);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    }
    await expect(page.getByTestId('sequence-message')).toHaveCount(2);
    await expect(page.getByText('Immediately · After subscribing')).toBeVisible();
    await expect(page.getByText('After 1 day · After the previous message')).toBeVisible();

    const second = page.getByRole('switch', { name: 'Send message 2' });
    await expect(second).toBeChecked();
    await second.click();
    await expect(second).not.toBeChecked();
    expect(writes.map((w) => w.method)).toEqual(['POST', 'POST', 'POST', 'PATCH']);
    expect(writes.at(-1)).toMatchObject({ method: 'PATCH', body: { active: false } });
    expect(writes[1].body).toEqual({ create: { name: 'Day one' } });
  });
});
