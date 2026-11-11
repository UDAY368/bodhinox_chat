import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Phase 11 (Instagram). Local and CI runs leave INSTAGRAM_ENABLED unset, so
// every Instagram part must show its "not enabled" state, connect must answer
// the fixed 503, the callback must redirect back to Settings with
// code=instagram_not_enabled, and the browser must never reach instagram.com
// or graph.instagram.com.

// Where the Instagram card lives in Settings (INSTAGRAM_SETTINGS_PATH in src/lib/instagram/connection.ts).
const INSTAGRAM_SETTINGS_URL = '/settings?tab=instagram';

/** Collects every request the page makes to an Instagram host. */
function watchInstagramRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (request) => {
    let host = '';
    try {
      host = new URL(request.url()).hostname;
    } catch {
      return;
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) hits.push(host);
  });
  return hits;
}

async function staffPost(page: Page, url: string) {
  const origin = new URL(page.url()).origin;
  await page.request.get('/api/auth/csrf');
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === '__Host-bnx_csrf' || c.name === 'bnx_csrf');
  return page.request.post(url, {
    headers: { origin, 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') },
    data: {},
  });
}

test.describe('instagram with INSTAGRAM_ENABLED unset', () => {
  test('Settings shows Instagram as not available, with no connect button', async ({ page }) => {
    const hits = watchInstagramRequests(page);
    await login(page, fixtures().users.admin);
    // Stage 1: a channel the workspace cannot use has no Settings tab; the old
    // link opens Settings › Channels, which says why Instagram is unavailable.
    await page.goto(INSTAGRAM_SETTINGS_URL);
    const instagram = page.locator('[data-channel-row="instagram"]');
    await expect(instagram).toHaveAttribute('data-channel-state', 'unavailable');
    await expect(instagram.getByText("Instagram isn't available yet.")).toBeVisible();
    await expect(instagram.getByRole('switch')).toBeDisabled();
    const rail = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(rail.getByRole('button', { name: 'Channels', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(rail.getByRole('button', { name: 'Instagram', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect Instagram' })).toHaveCount(0);
    expect(hits).toEqual([]);
  });

  test('the inbox has no Instagram banner or channel filter', async ({ page }) => {
    const hits = watchInstagramRequests(page);
    await login(page, fixtures().users.agent);
    await page.goto('/inbox');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText('Instagram needs reconnecting')).toHaveCount(0);
    await expect(page.getByText('Instagram account disconnected')).toHaveCount(0);
    // The filter trigger is labelled "Channel: <selection>", never bare "Channel".
    await expect(page.getByLabel(/^Channel:/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Channel:/ })).toHaveCount(0);
    await expect(page.getByText('All channels')).toHaveCount(0);
    expect(hits).toEqual([]);
  });

  test('status answers enabled:false, connect answers 503 and the callback redirects for an admin', async ({ page }) => {
    const hits = watchInstagramRequests(page);
    await login(page, fixtures().users.admin);
    await page.goto('/inbox');

    const status = await page.request.get('/api/instagram/status');
    expect(status.status()).toBe(200);
    const body = await status.json();
    expect(body.enabled).toBe(false);
    expect(body.reason).toBe('flag_off');
    expect(JSON.stringify(body)).not.toMatch(/secret|token/i);

    const connect = await staffPost(page, '/api/instagram/connect');
    expect(connect.status()).toBe(503);
    expect((await connect.json()).error).toBe('instagram_not_enabled');
    expect(connect.headers()['location']).toBeUndefined();

    // The callback is a browser navigation, so while off it redirects back to
    // Settings with the fixed code and never exchanges the code with Instagram.
    const callback = await page.request.get('/api/instagram/callback?code=e2e&state=e2e', { maxRedirects: 0 });
    expect(callback.status()).toBe(303);
    const location = new URL(callback.headers()['location'] ?? '', page.url());
    expect(location.hostname).not.toMatch(/instagram\.com$/);
    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('instagram')).toBe('error');
    expect(location.searchParams.get('code')).toBe('instagram_not_enabled');

    expect(hits).toEqual([]);
  });

  test('connect answers 503 before any session check', async ({ request }) => {
    const connect = await request.post('/api/instagram/connect', { data: {} });
    expect(connect.status()).toBe(503);
    expect((await connect.json()).error).toBe('instagram_not_enabled');
  });
});
