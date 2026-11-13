import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Phase 10 (click-to-WhatsApp ads). Local and CI runs leave META_ADS_ENABLED
// unset, so every Meta-calling part must show its "not enabled" state and no
// Meta network is involved. Referral capture, the ad-click flow trigger and the
// ad segment filter need no Meta permission and work with the flag off.

test.describe('ads with META_ADS_ENABLED unset', () => {
  test('the Ads page needs a session', async ({ page }) => {
    await page.goto('/ads');
    await expect(page).toHaveURL(/\/login/);
  });

  test('the Ads page shows the not-enabled state', async ({ page }) => {
    await login(page, fixtures().users.admin);
    await page.goto('/ads');
    // Ads is a Campaigns tab: the page heading is "Campaigns" (the dashboard header also has an h1, so look in the page content only).
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Campaigns', exact: true })).toBeVisible();
    await expect(page.getByText('Ads are not enabled')).toBeVisible();
  });

  test('Settings > Ads shows not configured', async ({ page }) => {
    await login(page, fixtures().users.admin);
    await page.goto('/settings?tab=ads');
    await expect(page.getByText('Meta ads are not enabled on this deployment yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect with Facebook' })).toHaveCount(0);
  });

  test('an agent saves and activates a flow with the ad-click trigger', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/flows');
    await page.getByRole('button', { name: 'New automation' }).first().click();
    // A gallery template already passes activation checks; a blank flow has no steps.
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Search templates').fill('welcome menu');
    // Pick the card by its exact name: other templates' descriptions can mention it
    // (Journey menu is "A welcome menu with four journeys").
    await dialog.getByRole('button', { name: 'Use this: Welcome menu', exact: true }).click();
    await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);
    // The trigger panel lives in the list view; the editor opens on the canvas.
    await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();

    await page.getByRole('combobox').filter({ hasText: 'A message contains a keyword' }).click();
    await page.getByRole('option', { name: 'A customer messages you from an ad' }).click();
    await page.getByLabel('Ad IDs (optional)').fill('1234567890');
    await page.getByLabel('Ad IDs (optional)').press('Enter');
    await page.getByRole('button', { name: 'Save now', exact: true }).click();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await page.getByTestId('flow-version-bar').getByRole('button', { name: 'Publish', exact: true }).click();
    // Publishing makes v1 live; the version bar then offers Pause.
    const versionBar = page.getByTestId('flow-version-bar');
    await expect(versionBar.getByText('Live v1')).toBeVisible();
    await expect(versionBar.getByRole('button', { name: 'Pause' })).toBeVisible();

    await page.reload();
    await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();
    await expect(page.getByRole('combobox').filter({ hasText: 'A customer messages you from an ad' })).toBeVisible();
    await expect(page.getByText('1234567890', { exact: true })).toBeVisible();
  });

  test('an agent saves a segment of contacts who clicked an ad and broadcasts to it', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'New segment' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(`Ad clickers ${fixtures().runId}`);
    const row = dialog.getByTestId('segment-condition');
    await row.getByLabel('Field').selectOption('ad');
    await expect(dialog.getByTestId('segment-count')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save segment' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel('Segment', { exact: true })).toHaveValue(/.+/);
    const segmentId = await page.getByLabel('Segment', { exact: true }).inputValue();

    // "Broadcast to these leads" opens /broadcasts/new?segmentId=...; the
    // audience step must start on that segment, not on all contacts.
    await page.goto(`/broadcasts/new?segmentId=${encodeURIComponent(segmentId)}`);
    await page.getByRole('button', { name: /e2e_template/ }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByLabel('Choose a segment')).toHaveValue(segmentId);

    // An id that is not one of this workspace's segments is ignored.
    await page.goto('/broadcasts/new?segmentId=00000000-0000-0000-0000-000000000000');
    await page.getByRole('button', { name: /e2e_template/ }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByLabel('Choose a segment')).toHaveCount(0);
  });
});
