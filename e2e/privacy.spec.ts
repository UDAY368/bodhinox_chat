import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';
import { removeWorkspaces, seedWorkspace, withDb, type Workspace } from './journeys';

// Settings → Privacy: the workspace export card and the owner's deletion request
// with its 30-day grace period and cancel. End-to-end runs have no private file
// storage, so the export card must say exports are unavailable rather than offer
// a request that cannot complete (export jobs are unit-tested in lib/jobs).
let workspace: Workspace;
const lifecycle = (accountId: string) => withDb(async (db) => (await db.query(
  'SELECT status, purge_after FROM account_lifecycle WHERE account_id=$1', [accountId])).rows[0] as { status: string; purge_after: Date | null } | undefined);

test.describe('[SEC-01] workspace export and deletion', () => {
  test.beforeAll(async () => { workspace = await seedWorkspace('privacy'); });
  test.afterAll(async () => { await removeWorkspaces([workspace.accountId], [workspace.owner.id]); });

  test('the export card says exports are unavailable without file storage', async ({ page }) => {
    await login(page, workspace.owner);
    await page.goto('/settings?tab=privacy');
    await expect(page.getByText('Export workspace data')).toBeVisible();
    await expect(page.getByText('Exports are not available because file storage is not set up on this server.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request export' })).toHaveCount(0);
  });

  test('the owner requests deletion with a 30-day grace period and cancels it', async ({ page }) => {
    await login(page, workspace.owner);
    await page.goto('/settings?tab=privacy');
    await page.getByRole('button', { name: 'Delete this workspace' }).click();
    const confirm = page.getByRole('button', { name: 'Request deletion' });
    await expect(confirm).toBeDisabled();
    await page.locator('#delete-workspace-name').fill(workspace.name);
    const password = page.locator('#delete-workspace-password');
    if (await password.count()) await password.fill(workspace.owner.password);
    await confirm.click();
    await expect(page.getByRole('status').filter({ hasText: 'Deletion requested' })).toBeVisible();

    const closing = await lifecycle(workspace.accountId);
    expect(closing?.status).toBe('closing');
    const days = (closing!.purge_after!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    await page.getByRole('button', { name: 'Cancel deletion request' }).click();
    await expect(page.getByText(/The deletion request was cancelled/)).toBeVisible();
    expect((await lifecycle(workspace.accountId))?.status).not.toBe('closing');
  });

  test('a non-owner cannot request deletion', async ({ page }) => {
    await login(page, fixtures().users.admin);
    await page.goto('/settings?tab=privacy');
    await expect(page.getByText('Only the workspace owner can request deletion.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete this workspace' })).toHaveCount(0);
  });
});
