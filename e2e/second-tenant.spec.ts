import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { login } from './fixtures';
import { removeWorkspaces, seedWorkspace, withDb, type Workspace } from './journeys';

// Two workspaces signed in side by side in two browser contexts. Each sees only
// its own contacts, inbox and orders, and the other workspace's ids typed into
// the URL show "not found" without any of the other workspace's data.
interface Tenant extends Workspace { contactName: string; conversationId: string; orderId: string; message: string }
let a: Tenant, b: Tenant;

async function seedTenant(label: string): Promise<Tenant> {
  const workspace = await seedWorkspace(label);
  const contactId = randomUUID(), conversationId = randomUUID(), orderId = randomUUID();
  const contactName = `${workspace.name} customer`;
  const message = `Hello from ${workspace.name}`;
  await withDb(async (db) => {
    await db.query('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)',
      [contactId, workspace.accountId, workspace.owner.id, contactName, `1417${String(Date.now()).slice(-7)}`]);
    await db.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [conversationId, workspace.accountId, workspace.owner.id, contactId]);
    await db.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_text) VALUES($1,$2,'customer',$3)", [workspace.accountId, conversationId, message]);
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
        tax_inclusive,total_minor,status,priced_at,paid_at,amount_paid_minor,checkout_attempt)
      VALUES($1,$2,'storefront',$3,'INR',12300,0,0,0,true,12300,'paid',NOW(),NOW(),12300,1)`, [orderId, workspace.accountId, contactId]);
  });
  return { ...workspace, contactName, conversationId, orderId, message };
}

async function signedIn(browser: Browser, tenant: Tenant): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, tenant.owner);
  return page;
}

test.describe('[TEN-01] [SEC-03] two tenants side by side', () => {
  test.beforeAll(async () => {
    a = await seedTenant('tenant-a');
    b = await seedTenant('tenant-b');
  });
  test.afterAll(async () => { await removeWorkspaces([a.accountId, b.accountId], [a.owner.id, b.owner.id]); });

  test('each workspace lists only its own contacts and conversations', async ({ browser }) => {
    const [pageA, pageB] = [await signedIn(browser, a), await signedIn(browser, b)];
    for (const [page, own, other] of [[pageA, a, b], [pageB, b, a]] as const) {
      await page.goto('/contacts');
      await expect(page.getByText(own.contactName).first()).toBeVisible();
      await expect(page.getByText(other.contactName)).toHaveCount(0);
      await page.goto('/inbox');
      await expect(page.getByText(own.contactName).first()).toBeVisible();
      await expect(page.getByText(other.contactName)).toHaveCount(0);
      await expect(page.getByText(other.message)).toHaveCount(0);
    }
    await pageA.context().close();
    await pageB.context().close();
  });

  test("the other workspace's ids in the URL show not found and none of its data", async ({ browser }) => {
    const page = await signedIn(browser, a);
    await page.goto(`/commerce/orders/${b.orderId}`);
    await expect(page.getByText(/doesn.t exist or isn.t in this workspace/)).toBeVisible();
    await expect(page.getByText(b.contactName)).toHaveCount(0);

    // Its own order still opens.
    await page.goto(`/commerce/orders/${a.orderId}`);
    await expect(page.getByText(/doesn.t exist or isn.t in this workspace/)).toHaveCount(0);

    await page.goto(`/inbox?c=${b.conversationId}`);
    await expect(page.getByText(a.contactName).first()).toBeVisible();
    await expect(page.getByText(b.contactName)).toHaveCount(0);
    await expect(page.getByText(b.message)).toHaveCount(0);

    // The data gateway itself answers 404 for the other tenant's order, with the session's own cookies.
    const api = await page.request.get(`/api/commerce/orders/${b.orderId}`);
    expect([403, 404]).toContain(api.status());
    expect(await api.text()).not.toContain(b.contactName);
    await page.context().close();
  });
});
