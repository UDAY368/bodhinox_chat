import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Phase 9: Zoom meetings and Shiprocket shipping are off by default. The E2E
// server has no ZOOM_* configuration and no workspace has a connection, so
// nothing may call a provider: Settings shows Zoom as not available and
// Shiprocket as not connected, a paid order offers no courier shipment and
// keeps staff-recorded dispatch, and an online appointment keeps its supplied
// link. Seed: global-setup seedIntegrations.

test.describe('meetings and shipping without provider configuration', () => {
  test('Settings shows Zoom as not available and Shiprocket as not connected', async ({ page }) => {
    await login(page, fixtures().users.owner);
    await page.goto('/settings?tab=connections');
    await expect(page.getByText('Not available on this deployment').first()).toBeVisible();
    await expect(page.getByText('Not connected').first()).toBeVisible();
    // The Shiprocket connection form is offered to admins.
    await expect(page.getByLabel(/API user email/i).first()).toBeVisible();
  });

  test('the Zoom status route reports not available', async ({ page }) => {
    await login(page, fixtures().users.owner);
    const status = await page.request.get('/api/integrations/zoom');
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ available: false, connected: false });
    expect(status.headers()['cache-control']).toContain('no-store');
  });

  test('a paid order offers no courier shipment and keeps staff-recorded dispatch', async ({ page }) => {
    const { unshippedOrderId } = fixtures().integrations;
    await login(page, fixtures().users.owner);
    await page.goto(`/commerce/orders/${unshippedOrderId}`);
    await expect(page.getByRole('button', { name: 'Mark dispatched' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Create shipment/i })).toHaveCount(0);
    const detail = await page.request.get(`/api/commerce/orders/${unshippedOrderId}`);
    expect(detail.status()).toBe(200);
  });

  test('an online appointment shows its supplied meeting link', async ({ page }) => {
    const { onlineAppointmentId, meetingUrl } = fixtures().integrations;
    await login(page, fixtures().users.owner);
    await page.goto(`/appointments?id=${onlineAppointmentId}`);
    await expect(page.locator(`a[href="${meetingUrl}"]`).first()).toBeVisible();
  });
});
