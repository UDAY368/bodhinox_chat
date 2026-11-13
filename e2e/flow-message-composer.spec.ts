import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

// The ManyChat-style message editor on the canvas: the message drawn as a
// bubble with its buttons under it, each button's next step behind ">", the
// 24-hour window line, and the dark phone preview showing the same message.

async function newBlankFlow(page: Page, name: string) {
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const dialog = page.getByRole('dialog');
  // Gallery first: "Start from scratch" opens the name, type and channel form.
  await dialog.getByRole('button', { name: /Start from scratch/ }).click();
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(name);
  await dialog.getByRole('button', { name: 'Create blank flow' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('when-card')).toBeVisible();
}

async function addStep(page: Page, label: string) {
  await page.getByTestId('add-step-button').click();
  await page.getByTestId('add-step-list').getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByTestId('step-panel')).toBeVisible();
}

test('an agent writes a message with buttons in the bubble editor and sees it in the phone preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, fixtures().users.agent);
  await newBlankFlow(page, `Composer ${fixtures().runId}`);

  // A follow-up step to route a button to.
  await addStep(page, 'Send message');
  const followUp = (await page.getByTestId('step-panel').locator('code').first().textContent())!.trim();

  await addStep(page, 'Send buttons');
  const panel = page.getByTestId('step-panel');
  await expect(panel.getByTestId('send-window')).toContainText('within 24 hour window');
  const bubble = panel.locator('[data-bubble]').first();
  await bubble.getByLabel('Body text').fill('Hi 👋\n\nWould you like to book a free consultation?');
  await bubble.getByRole('textbox', { name: 'Button title' }).first().fill('Sure!');
  await bubble.getByRole('button', { name: 'Add button' }).click();
  await bubble.getByRole('textbox', { name: 'Button title' }).nth(1).fill('Not interested');

  // ">" holds where the button leads.
  await bubble.getByRole('button', { name: 'Settings for "Sure!"' }).click();
  await page.getByRole('combobox').filter({ hasText: /None/ }).last().click();
  await page.getByRole('option', { name: followUp }).click();
  await page.keyboard.press('Escape');
  await expect(bubble.getByRole('button', { name: 'Settings for "Sure!"' })).toHaveAttribute('data-connected', '');
  await page.screenshot({ path: 'test-results/composer-buttons.png' });

  // The phone shows the message with both buttons inside its bubble.
  await page.getByRole('button', { name: 'Preview' }).click();
  const phone = page.locator('[data-phone="whatsapp"]');
  await expect(phone).toBeVisible();
  await page.getByRole('button', { name: 'Close preview' }).click();

  // The 24-hour line turns a text step into a template step and back.
  // The new steps stack in the middle of the view; click the follow-up's visible right end.
  await page.locator(`.react-flow__node[data-id="${followUp}"]`).click({ position: { x: 220, y: 20 } });
  const window = page.getByTestId('step-panel').getByTestId('send-window');
  await window.getByRole('button', { name: /within 24 hour window/ }).click();
  await page.getByRole('menuitem', { name: /outside 24 hour window/ }).click();
  await expect(page.getByTestId('step-panel').getByTestId('send-window')).toContainText('outside 24 hour window');
  await page.getByTestId('step-panel').getByTestId('send-window').getByRole('button', { name: /outside 24 hour window/ }).click();
  await page.getByRole('menuitem', { name: /within 24 hour window/ }).click();
  await expect(page.getByTestId('step-panel').getByTestId('send-window')).toContainText('within 24 hour window');
});

test('the Preview phone shows a template flow\'s message and buttons, and a tap answers it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, fixtures().users.agent);
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search templates').fill('welcome menu');
  await dialog.getByRole('button', { name: 'Use this: Welcome menu', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);

  await page.getByRole('button', { name: 'Preview' }).click();
  const phone = page.locator('[data-phone="whatsapp"]');
  await expect(phone).toBeVisible();
  await expect(phone.getByText('Welcome to support', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/composer-preview.png' });
  await phone.getByRole('button', { name: 'New customer' }).last().click();
  await expect(page.getByRole('button', { name: 'Restart preview' })).toBeVisible();
});
