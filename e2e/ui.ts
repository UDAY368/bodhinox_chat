import type { Locator, Page } from '@playwright/test';

/** Opens a shared Select (a Base UI combobox) and picks the option with this exact name. */
export async function pickOption(page: Page, select: Locator, name: string | RegExp) {
  await select.click();
  await page.getByRole('option', { name, exact: typeof name === 'string' }).click();
}

/** Answers the in-app confirm (ConfirmDialog) by clicking its button with this name. */
export async function confirmInApp(page: Page, name: string) {
  await page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click();
}
