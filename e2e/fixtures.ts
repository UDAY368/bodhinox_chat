import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export type Role = 'owner' | 'admin' | 'agent' | 'viewer';
export interface SeededUser { id: string; email: string; password: string }
export interface Fixtures {
  runId: string;
  accountA: string;
  accountB: string;
  /** Members of workspace A by role. */
  users: Record<Role, SeededUser>;
  /** Owner of workspace B, used for tenancy checks. */
  outsider: SeededUser;
  /** A contact in workspace A with no consent flags set. */
  contact: { id: string; name: string };
}

// Outside the project (the dev server reloads on project file writes); it
// holds this run's throwaway test passwords and is deleted on teardown.
export const FIXTURES_FILE = path.join(os.tmpdir(), 'bodhinox-e2e', 'fixtures.json');

export function fixtures(): Fixtures {
  return JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8')) as Fixtures;
}

/** Sign in through the real login form and wait to leave /login. */
export async function login(page: Page, user: SeededUser) {
  // The suite signs the same seeded users in more often than the real 10-per-15-minutes
  // limit allows; clear it in the isolated test database (testDatabase refuses any other).
  const { testDatabase } = await import('./global-setup');
  const db = await testDatabase();
  try {
    await db.query('DELETE FROM auth_rate_limits');
  } finally {
    await db.end();
  }
  await page.goto('/login');
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
}
