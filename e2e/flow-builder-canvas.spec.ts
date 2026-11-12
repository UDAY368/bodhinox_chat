import { expect, test, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Stage 5 builder: the round "+" add-step menu, drag-to-create from the
// "When…" card, the left side-panel editor, undo of a delete, autosave
// ("Saved") and a reload that finds the draft intact.

async function newBlankFlow(page: Page, name: string) {
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(name);
  await dialog.getByRole('button', { name: 'Create blank flow' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('when-card')).toBeVisible();
}

const saved = (page: Page) => expect(page.locator('[data-save-state="saved"]')).toBeVisible({ timeout: 15_000 });

test('an agent builds on the canvas with "+", edits in the side panel, undoes a delete and finds the autosaved draft after a reload', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await newBlankFlow(page, `Canvas ${fixtures().runId}`);

  // "+" opens the grouped menu; the new step opens in the left side panel.
  await page.getByTestId('add-step-button').click();
  await page.getByTestId('add-step-list').getByRole('button', { name: 'Send message' }).click();
  const panel = page.getByTestId('step-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Text sent to the customer').fill('Hello from the canvas');
  await saved(page);

  // Escape closes the panel; the canvas stays.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // Delete the step, then undo it from the keyboard (focus is not in a text field).
  const card = page.locator('.react-flow__node-flow').filter({ hasText: 'Hello from the canvas' });
  await card.click();
  await page.getByTestId('step-panel').getByRole('button', { name: 'Delete node' }).click();
  await expect(card).toHaveCount(0);
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+z');
  await expect(card).toHaveCount(1);
  await saved(page);

  // Reload: the draft (with the restored step) is still there.
  await page.reload();
  await expect(page.locator('.react-flow__node-flow').filter({ hasText: 'Hello from the canvas' })).toHaveCount(1);
  await page.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Simple builder' }).click();
  await expect(page.getByText('Hello from the canvas').first()).toBeVisible();
});

test('dragging from the "Then" port to empty canvas offers the step menu and connects the new first step', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await newBlankFlow(page, `Drag ${fixtures().runId}`);

  const handle = page.locator(`.react-flow__node[data-id="__when__"] .react-flow__handle[data-handleid="then"]`);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 40, { steps: 12 });
  await page.mouse.up();

  const picker = page.getByRole('dialog', { name: 'Add a step here' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'If / else' }).click();
  await expect(page.getByTestId('step-panel')).toBeVisible();
  // The new step is the flow's first step: the When… card's edge leads to it.
  await expect(page.locator('.react-flow__edge[data-id^="__when__->"]')).toHaveCount(1);
  await saved(page);
});

test('clicking a step output opens the next-step menu; help and the automation panel open from the canvas', async ({ page }) => {
  await login(page, fixtures().users.agent);
  await newBlankFlow(page, `Click ${fixtures().runId}`);

  // A click (no drag) on the "Then" port offers the next step and links it.
  await page.locator(`.react-flow__node[data-id="__when__"] .react-flow__handle[data-handleid="then"]`).click();
  const picker = page.getByRole('dialog', { name: 'Add a step here' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.react-flow__edge[data-id^="__when__->"]')).toHaveCount(1);
  await page.getByTestId('step-panel').getByLabel('Text sent to the customer').fill('First message');
  await page.keyboard.press('Escape');

  // The message step's "Next step" output does the same and links the two steps.
  const before = await page.locator('.react-flow__edge').count();
  await page.locator('.react-flow__node-flow [data-next-step] .react-flow__handle').first().click();
  await page.getByRole('dialog', { name: 'Add a step here' }).getByRole('button', { name: 'If / else' }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(before + 1);
  await page.keyboard.press('Escape');

  // There is no separate block library: the round + menu is the one place to add a step.
  await expect(page.getByRole('button', { name: /block library/i })).toHaveCount(0);

  // The + menu folds its groups: Content open, one group at a time, every match while searching.
  await page.getByTestId('add-step-button').click();
  const menu = page.locator('[data-testid="add-step-list"][data-variant="tiles"]');
  await expect(menu).toBeVisible();
  const content = menu.getByRole('button', { name: /^Content/ });
  const logic = menu.getByRole('button', { name: /^Logic/ });
  await expect(content).toHaveAttribute('aria-expanded', 'true');
  await expect(logic).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  // A closed group's steps are out of reach (inert: no tabbing or screen reader), not just clipped.
  await expect(menu.getByRole('region', { name: 'Logic' })).toHaveAttribute('inert', '');
  await logic.click();
  await expect(logic).toHaveAttribute('aria-expanded', 'true');
  await expect(content).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.getByRole('region', { name: 'Logic' })).not.toHaveAttribute('inert', '');
  await expect(menu.getByRole('button', { name: 'If / else' })).toBeVisible();
  await page.screenshot({ path: 'test-results/add-menu-logic-open.png' });
  await logic.click();
  await expect(logic).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('textbox', { name: 'Search blocks…' }).fill('message');
  await expect(content).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('show-flow-summary').click();
  await expect(page.getByTestId('flow-summary-panel')).toContainText(`Click ${fixtures().runId}`);
  await page.getByTestId('canvas-help').click();
  await expect(page.getByRole('dialog', { name: 'Moving around the canvas' })).toBeVisible();
  await page.getByRole('tab', { name: 'Trackpad' }).click();
  await expect(page.getByText('Pinch, or scroll with two fingers')).toBeVisible();
  await saved(page);
});

// Two triggers need an Instagram flow, which needs INSTAGRAM_ENABLED and a
// connected account; the default e2e environment has neither.
test('an Instagram flow starts on two triggers', async ({ page }) => {
  test.skip(process.env.E2E_INSTAGRAM !== '1', 'needs INSTAGRAM_ENABLED and a connected Instagram account');
  await login(page, fixtures().users.agent);
  await page.goto('/instagram/flows');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g. Welcome menu').fill(`Two triggers ${fixtures().runId}`);
  await dialog.getByRole('button', { name: 'Create blank flow' }).click();
  await expect(page.getByTestId('when-card')).toBeVisible();

  await page.getByTestId('when-card').getByRole('button', { name: 'New trigger' }).click();
  await page.getByRole('dialog', { name: 'Start this automation when…' }).getByRole('button', { name: 'Someone replies to your story' }).click();
  await expect(page.getByTestId('when-card').getByText('Someone replies to your story')).toBeVisible();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('when-card').getByText('Someone replies to your story')).toBeVisible();
});
