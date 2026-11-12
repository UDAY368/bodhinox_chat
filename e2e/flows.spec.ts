import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

test('an agent adds a location question with a reply timeout to a new flow', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(`Location ${fixtures().runId}`);
  await dialog.getByRole('button', { name: 'Create blank flow' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);

  // The block library starts closed; the round + menu adds the step.
  await page.getByTestId('add-step-button').click();
  await page.getByTestId('add-step-list').getByRole('button', { name: 'Ask for location' }).click();
  await page.getByLabel(/^Variable key/).fill('pickup');
  await page.getByText('Timing').click();
  await page.getByLabel('Stop waiting for a reply after (minutes)').fill('30');

  // The timeout adds its own port, and the missing target is a validation error.
  await expect(page.getByText('Timeout', { exact: true }).first()).toBeVisible();
  await page.getByText(/\d+ errors?, \d+ warnings?/).click();
  await expect(page.getByText('Choose a node for the timeout path.')).toBeVisible();
});

test('an agent starts from a gallery template, previews it, duplicates it and finds the copy', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search templates').fill('welcome menu');
  // Pick the card by its exact name: other templates' descriptions can mention it
  // (Journey menu is "A welcome menu with four journeys").
  await dialog.getByRole('button', { name: 'Use this: Welcome menu', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);

  // The preview walks the template like a customer would, without sending anything.
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Welcome to support', { exact: false }).last()).toBeVisible();
  await page.getByRole('button', { name: 'New customer' }).last().click();
  await expect(page.getByRole('button', { name: 'Restart preview' })).toBeVisible();

  await page.goto('/flows');
  await page.getByPlaceholder('Search flows').fill('Welcome menu');
  // The search also matches Journey menu flows (their description says "welcome menu"), so duplicate the card named Welcome menu.
  // Each row's actions are in its "More actions" menu (Stage 5 list rows).
  await page.getByRole('button', { name: 'More actions: Welcome menu', exact: true }).last().click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);
  await page.goto('/flows');
  await page.getByPlaceholder('Search flows').fill('Copy of Welcome menu');
  await expect(page.getByText(/Copy of Welcome menu/).first()).toBeVisible();
  await expect(page.getByText(/Created by/).first()).toBeVisible();
});
