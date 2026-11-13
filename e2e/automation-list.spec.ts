import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

// The Automation list: flows, rules and sequences in one list with
// All / Flows / Rules / Sequences tabs, a Live switch that refuses an
// automation with problems, and Rename from the row menu.

test('a blank rule lists under Rules, renames from its menu, and a flow with problems will not go live', async ({ page }) => {
  const runId = fixtures().runId;
  // An admin: publishing a flow needs 'flows.publish', which a workspace may withhold from agents.
  await login(page, fixtures().users.admin);
  await page.goto('/automation?channel=whatsapp');

  // A blank rule from "Start from scratch" opens its builder.
  await page.getByRole('button', { name: 'New automation' }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Start from scratch/ }).click();
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(`Rule ${runId}`);
  await dialog.getByRole('radio', { name: 'Rule' }).click();
  await dialog.getByRole('button', { name: 'Create blank rule' }).click();
  await expect(page).toHaveURL(/\/whatsapp\/automations\/[0-9a-f-]{36}\/edit/);

  // It lists under Rules, with its type.
  await page.goto('/automation?channel=whatsapp');
  await page.getByRole('tab', { name: /^Rules/ }).click();
  await page.getByPlaceholder('Search automations').fill(`Rule ${runId}`);
  const row = page.locator('[data-automation-row^="rule:"]').filter({ hasText: `Rule ${runId}` });
  await expect(row).toHaveCount(1);

  // Rename from the row menu.
  await page.getByRole('button', { name: `More actions: Rule ${runId}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(`Renamed rule ${runId}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Renamed', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Search automations').fill(`Renamed rule ${runId}`);
  await expect(page.locator('[data-automation-row^="rule:"]').filter({ hasText: `Renamed rule ${runId}` })).toHaveCount(1);

  // A blank flow has no steps: its Live switch refuses with the problem count and stays off.
  await page.getByRole('button', { name: 'New automation' }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Start from scratch/ }).click();
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(`Empty flow ${runId}`);
  await dialog.getByRole('button', { name: 'Create blank flow' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);
  await page.goto('/automation?channel=whatsapp');
  await page.getByPlaceholder('Search automations').fill(`Empty flow ${runId}`);
  const live = page.getByRole('switch', { name: `Empty flow ${runId} live` });
  await live.click();
  await expect(page.getByText(/has \d+ problems?\. Open it to fix\./)).toBeVisible();
  await expect(live).not.toBeChecked();
});
