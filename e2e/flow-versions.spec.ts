import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Phase 12: publish a flow as a fixed version, see unpublished changes after
// an edit, dry-run it without creating a run, and publish v2.

async function staffPost(page: Page, url: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  await page.request.get('/api/auth/csrf');
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === '__Host-bnx_csrf' || c.name === 'bnx_csrf');
  return page.request.post(url, { headers: { origin, 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') }, data });
}

async function publish(page: Page, flowId: string) {
  const state = await (await page.request.get(`/api/flows/${flowId}/versions`)).json();
  const res = await staffPost(page, `/api/flows/${flowId}/activate`, { status: 'active', draft_hash: state.draft_hash });
  expect(res.status(), await res.text()).toBe(200);
}

test('a flow is published as v1, edited, dry-run without a run, and published as v2', async ({ page }) => {
  await login(page, fixtures().users.admin);
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search templates').fill('Journey menu');
  // Pick the card by its exact name: other templates' descriptions can mention it
  // (Journey menu is "A welcome menu with four journeys").
  await dialog.getByRole('button', { name: 'Use this: Journey menu', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);
  const flowId = /\/flows\/([0-9a-f-]{36})/.exec(page.url())![1];

  await publish(page, flowId);
  await page.reload();
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();
  const bar = page.getByTestId('flow-version-bar');
  await expect(bar.getByText('Live v1')).toBeVisible();

  // Edit the saved draft: rename the first message step's text through the API, as the editor's save does.
  const current = await (await page.request.get(`/api/flows/${flowId}`)).json();
  type Node = { node_key: string; node_type: string; config: Record<string, unknown>; position_x?: number; position_y?: number };
  const nodes = (current.nodes as Node[]).map(({ node_key, node_type, config, position_x, position_y }) => ({
    node_key, node_type, position_x, position_y,
    config: (node_type === 'send_message' || node_type === 'send_buttons') && typeof config.text === 'string'
      ? { ...config, text: `${config.text} (v2)` } : config,
  }));
  const origin = new URL(page.url()).origin;
  const csrf = (await page.context().cookies()).find((c) => c.name === '__Host-bnx_csrf' || c.name === 'bnx_csrf');
  const saved = await page.request.put(`/api/flows/${flowId}`, {
    headers: { origin, 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') },
    data: { nodes },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();
  await expect(bar.getByText('Unpublished changes')).toBeVisible();

  // Dry run: walks the saved draft and shows what would be sent; nothing runs.
  await bar.getByTestId('dry-run-open').click();
  const panel = page.getByTestId('dry-run-panel');
  await panel.getByTestId('dry-run-start').click();
  await expect(panel.getByTestId('dry-run-would').first()).toBeVisible();
  await expect(panel.getByTestId('dry-run-would').first()).toContainText(/Would send/i);
  await page.keyboard.press('Escape');
  const runs = await (await page.request.get(`/api/flows/${flowId}/runs`)).json();
  expect(runs.runs).toEqual([]);

  await publish(page, flowId);
  const versions = await (await page.request.get(`/api/flows/${flowId}/versions`)).json();
  expect(versions.versions).toHaveLength(2);
  await page.reload();
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();
  await expect(bar.getByText('Live v2')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Versions (2)' })).toBeVisible();
});
