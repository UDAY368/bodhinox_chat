import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

// The Simple builder: steps on the left (When…, connected, not connected),
// the selected step's settings in the middle, and the step in a phone on
// the right. Edits are the same draft the canvas edits.

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

const saved = (page: Page) => expect(page.locator('[data-save-state="saved"]')).toBeVisible({ timeout: 15_000 });

test('an agent builds a flow in the Simple builder: steps list, editor and phone preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });  await login(page, fixtures().users.agent);
  await newBlankFlow(page, `Simple ${fixtures().runId}`);
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();

  const builder = page.getByTestId('basic-builder');
  const steps = builder.getByRole('navigation', { name: 'Steps' });
  // Nothing selected yet: the When… trigger is open, and the phone asks for a step.
  await expect(steps.getByRole('button', { name: /When…/ })).toHaveAttribute('aria-current', 'true');
  await expect(builder.getByRole('combobox').first()).toBeVisible();
  await expect(page.getByTestId('step-phone')).toContainText('Pick a step');

  // The first step added becomes the first step, in one undo step: one undo removes it entirely.
  await steps.getByRole('button', { name: 'Add node' }).click();
  await page.getByRole('menuitem', { name: 'Send message' }).click();
  await expect(steps.getByText('Then… (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(steps.getByText('Then… (0)')).toBeVisible();
  await expect(steps.getByText(/Not connected/)).toHaveCount(0);
  await steps.getByRole('button', { name: 'Add node' }).click();
  await page.getByRole('menuitem', { name: 'Send message' }).click();
  const editor = page.getByTestId('step-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByText('Entry')).toBeVisible();
  await editor.getByLabel('Text sent to the customer').fill('Hello from the simple builder');
  await expect(steps.getByText('Then… (1)')).toBeVisible();
  await expect(steps.getByText('Hello from the simple builder')).toBeVisible();
  await expect(page.getByTestId('step-phone')).toContainText('Hello from the simple builder');

  // A second step that nothing leads to is listed apart.
  await steps.getByRole('button', { name: 'Add node' }).click();
  await page.getByRole('menuitem', { name: 'Send message' }).click();
  await expect(steps.getByText('Not connected (1)')).toBeVisible();
  await page.screenshot({ path: 'test-results/simple-builder.png' });

  // Renaming its key to the first step's key is refused, so both steps stay listed.
  const second = page.getByTestId('step-editor');
  const secondKey = (await second.locator('code').first().textContent())!.trim();
  await second.getByRole('button', { name: 'Show advanced' }).click();
  const keyField = second.getByLabel(/^Node key/);
  const firstKey = (await steps.locator('[data-step]').first().getAttribute('data-step'))!;
  await keyField.fill(firstKey);
  await expect(keyField).toHaveValue(secondKey);
  await expect(steps.getByText('Then… (1)')).toBeVisible();
  await expect(steps.getByText('Not connected (1)')).toBeVisible();

  // Its hover tool deletes it; the editor falls back to the trigger.
  await steps.locator('[data-step]').last().hover();
  await steps.getByRole('button', { name: /^Remove node: Send message$/ }).last().click();
  await expect(steps.getByText(/Not connected/)).toHaveCount(0);
  await expect(page.getByTestId('step-editor')).toHaveCount(0);
  await saved(page);

  // The canvas shows the same draft, and so does a reload.
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Canvas' }).click();
  await expect(page.locator('.react-flow__node-flow').filter({ hasText: 'Hello from the simple builder' })).toHaveCount(1);
  await page.reload();
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();
  await steps.getByText('Hello from the simple builder').click();
  await expect(page.getByTestId('step-editor').getByLabel('Text sent to the customer')).toHaveValue('Hello from the simple builder');
});
