import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test.describe('authentication', () => {
  test('a signed-out visitor is sent to login from a protected page', async ({ page }) => {
    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('#email')).toBeVisible();
  });

  test('a wrong password is rejected and stays on login', async ({ page }) => {
    const { owner } = fixtures().users;
    await page.goto('/login');
    await page.locator('#email').fill(owner.email);
    await page.locator('#password').fill(`${owner.password}x`);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a verified member signs in and reaches the dashboard', async ({ page }) => {
    await login(page, fixtures().users.agent);
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
