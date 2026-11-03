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
  /**
   * Phase 7 appointments in workspace A: an offline service bookable on
   * Mondays only, one practitioner at an Asia/Kolkata location with weekday
   * hours, an active booking page, and a confirmed appointment (for the
   * contact) whose manage-link token is derived here.
   */
  appointments: {
    serviceId: string;
    staffId: string;
    locationId: string;
    timezone: string;
    pageSlug: string;
    appointmentId: string;
    /** Local Monday (YYYY-MM-DD) of the seeded appointment. */
    appointmentDate: string;
    manageToken: string;
  };
  /**
   * Phase 8 commerce in workspace A (store checkout on, INR, prices include
   * 18% tax, one IN shipping rate): a published product whose only variant
   * has 1 unit in stock, two live storefront links for two contacts (the
   * second one's checkout of the same product must get out_of_stock), and a
   * paid storefront order with its settled payment and receipt.
   */
  commerce: {
    productId: string;
    productName: string;
    variantId: string;
    sku: string;
    /** Storefront token of the consent contact's shop session. */
    token: string;
    /** Storefront token of a second contact's shop session. */
    secondToken: string;
    paidOrderId: string;
    receiptNumber: string;
  };
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
