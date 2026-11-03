import { expect, test } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Phase 7 public booking and the customer's manage link. The seed (global-setup)
// has a Monday-only service at an Asia/Kolkata location, one practitioner, an
// active booking page and a confirmed appointment with a known manage token.

test.describe('public booking page', () => {
  test('an anonymous visitor sees Mondays only and gets a WhatsApp code', async ({ page }) => {
    const { pageSlug } = fixtures().appointments;
    await page.goto(`/book/${pageSlug}`);
    const dates = page.getByRole('listbox', { name: 'Choose a date' }).getByRole('option');
    // On a Monday after the last free time, the 7-day window from today holds no Monday: page to the next one.
    const noDates = page.getByText('No free dates in the coming days.');
    await expect(dates.first().or(noDates)).toBeVisible();
    if (await noDates.isVisible()) await page.getByRole('button', { name: 'Later dates' }).click();
    await expect(dates.first()).toBeVisible();
    for (const label of await dates.allInnerTexts()) expect(label).toMatch(/^Mon/);
    await expect(page.getByText('Times in GMT+5:30')).toBeVisible();

    await page.getByRole('listbox', { name: 'Choose a time' }).getByRole('option').first().click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('We use WhatsApp only to confirm this booking')).toBeVisible();
    await expect(page.getByLabel('Phone')).toHaveCount(0);
    await page.getByLabel('Name').fill('E2E Walk-in');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText('Confirm on WhatsApp')).toBeVisible();
    await expect(page.getByTestId('booking-hold-message')).toHaveText(/^BOOK [A-HJ-NP-Z2-9]{6}$/);
  });

  test('an unknown page is a plain not-found', async ({ page }) => {
    await page.goto('/book/no-such-page-e2e');
    await expect(page.getByText('This booking page is not available.')).toBeVisible();
  });

  test('a signed-in staff browser can still post to the public booking API', async ({ page, baseURL }) => {
    const { pageSlug, serviceId, locationId, appointmentDate } = fixtures().appointments;
    await login(page, fixtures().users.owner);
    // The seeded Monday (2 to 8 days out) always has free times, whatever day and hour the suite runs.
    const slots = await page.request.get(
      `/api/public/booking/${pageSlug}/slots?service=${serviceId}&location=${locationId}&from=${appointmentDate}&days=1`);
    expect(slots.status()).toBe(200);
    const { slots: free } = await slots.json();
    expect(free.length).toBeGreaterThan(0);
    // The public route checks Origin itself; no staff CSRF header is needed.
    const hold = await page.request.post(`/api/public/booking/${pageSlug}`, {
      headers: { origin: new URL(baseURL as string).origin },
      data: { serviceId, locationId, startAt: free.at(-1).startAt, requestId: crypto.randomUUID() },
    });
    expect(hold.status()).toBe(201);
    expect((await hold.json()).holdCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
});

test.describe('customer manage link', () => {
  test('shows the booking without customer data and cancels it', async ({ page }) => {
    const { manageToken } = fixtures().appointments;
    await page.goto(`/my-booking/${manageToken}`);
    await expect(page).toHaveTitle(/Your booking/);
    await expect(page.getByText('Dr E2E')).toBeVisible();
    await expect(page.getByTestId('booking-when')).toContainText('4:00');
    const body = page.locator('body');
    await expect(body).not.toContainText(fixtures().contact.name);

    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(page.getByText('Cancel this booking?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(page.getByText('Your booking is cancelled.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
  });

  test('a made-up token is a plain not-found', async ({ page }) => {
    await page.goto(`/my-booking/${'Z'.repeat(43)}`);
    await expect(page.getByText('This booking link is not valid.')).toBeVisible();
  });
});

test.describe('tenancy', () => {
  test("another workspace's user gets 404 for this workspace's appointment", async ({ page }) => {
    await login(page, fixtures().outsider);
    const response = await page.request.get(`/api/appointments/${fixtures().appointments.appointmentId}`);
    expect(response.status()).toBe(404);
  });
});
