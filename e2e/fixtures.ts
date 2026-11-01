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
}

// Outside the project (the dev server reloads on project file writes); it
// holds this run's throwaway test passwords and is deleted on teardown.
export const FIXTURES_FILE = path.join(os.tmpdir(), 'bodhinox-e2e', 'fixtures.json');

export function fixtures(): Fixtures {
  return JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8')) as Fixtures;
}

/** Sign in through the real login form and wait to leave /login. */
export async function login(page: Page, user: SeededUser) {
  await page.goto('/login');
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
}
