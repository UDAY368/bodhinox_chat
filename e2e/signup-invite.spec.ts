import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { login, type SeededUser } from './fixtures';
import { linkIn, mailTo, removeWorkspaces, seedWorkspace, withDb, type Workspace } from './journeys';
import { hashInviteToken } from '../src/lib/auth/invitations';

// Real sign-up through the form, with the verification mail read from the local
// SMTP capture (no mail leaves the machine). Regressions for cc6dbcb (an invited
// sign-up joins the inviting workspace instead of getting its own) and 3d7926f
// (MFA is optional for owners and admins).
const run = randomBytes(4).toString('hex');
const newUser = (label: string): SeededUser => ({
  id: '', email: `e2e-${run}-${label}@example.invalid`, password: `Aa1!${randomBytes(12).toString('base64url')}`,
});
const created: string[] = [];
let inviter: Workspace;

async function signUp(page: Page, user: SeededUser, path = '/signup') {
  await page.goto(path);
  await page.locator('#fullName').fill(`E2E ${user.email.split('@')[0]}`);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.locator('#confirmPassword').fill(user.password);
  // Present only while TERMS_VERSION is set.
  const terms = page.locator('#acceptTerms');
  if (await terms.count()) await terms.check();
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('Check your email')).toBeVisible();
}

/** Opens the verification link from the captured mail and returns the new user's id. */
async function verify(page: Page, user: SeededUser) {
  const mail = await mailTo(user.email);
  const link = linkIn(mail, `${new URL(page.url()).origin}/auth/callback?`);
  await page.goto(link);
  await expect(page).toHaveURL(/\/login\?verified=1/);
  const id = await withDb(async (db) => (await db.query('SELECT id::text FROM auth_users WHERE email=$1 AND email_verified_at IS NOT NULL', [user.email])).rows[0]?.id as string);
  expect(id).toBeTruthy();
  created.push(id);
  return id;
}

test.describe('[WFH-01] [WFH-02] sign-up and invitations', () => {
  test.beforeAll(async () => { inviter = await seedWorkspace('inviter'); });
  test.afterAll(async () => {
    await withDb(async (db) => {
      const owned = (await db.query('SELECT id::text FROM accounts WHERE owner_user_id = ANY($1::uuid[])', [created])).rows.map((r) => r.id);
      await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [owned]);
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [owned]);
    });
    await removeWorkspaces([inviter.accountId], [inviter.owner.id, ...created]);
  });

  test('a new sign-up verifies its email and becomes the owner of its own workspace; MFA is not demanded', async ({ page }) => {
    const user = newUser('owner');
    await signUp(page, user);
    // Unverified: sign-in is refused until the link is opened.
    await page.goto('/login');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(user.password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login/);

    user.id = await verify(page, user);
    await login(page, user);
    await expect(page).toHaveURL(/\/dashboard/);
    const memberships = await withDb(async (db) => (await db.query(
      'SELECT m.role, a.owner_user_id::text AS owner FROM account_memberships m JOIN accounts a ON a.id=m.account_id WHERE m.user_id=$1', [user.id])).rows);
    expect(memberships).toEqual([{ role: 'owner', owner: user.id }]);
  });

  test('an invited sign-up joins the inviting workspace with the invited role and gets no workspace of its own', async ({ page }) => {
    const token = randomBytes(32).toString('base64url');
    const invitationId = randomUUID();
    await withDb((db) => db.query(`INSERT INTO account_invitations(id,account_id,token_hash,role,created_by_user_id,expires_at)
      VALUES($1,$2,$3,'agent',$4,NOW() + interval '7 days')`, [invitationId, inviter.accountId, hashInviteToken(token), inviter.owner.id]));
    const user = newUser('invitee');
    await signUp(page, user, `/signup?invite=${encodeURIComponent(token)}`);
    user.id = await verify(page, user);
    await login(page, user);
    await expect(page).toHaveURL(/\/dashboard/);

    const rows = await withDb(async (db) => ({
      memberships: (await db.query('SELECT account_id::text, role FROM account_memberships WHERE user_id=$1', [user.id])).rows,
      owned: (await db.query('SELECT count(*)::int AS n FROM accounts WHERE owner_user_id=$1', [user.id])).rows[0].n,
      invitation: (await db.query('SELECT accepted_by_user_id::text AS by FROM account_invitations WHERE id=$1', [invitationId])).rows[0],
    }));
    expect(rows.memberships).toEqual([{ account_id: inviter.accountId, role: 'agent' }]);
    expect(rows.owned).toBe(0);
    expect(rows.invitation.by).toBe(user.id);
    // The dashboard shows the inviting workspace.
    await expect(page.getByText(inviter.name).first()).toBeVisible();
  });

  test('a used invitation link is refused on a second sign-up', async ({ page }) => {
    const token = randomBytes(32).toString('base64url');
    await withDb((db) => db.query(`INSERT INTO account_invitations(account_id,token_hash,role,created_by_user_id,expires_at,accepted_at)
      VALUES($1,$2,'agent',$3,NOW() + interval '7 days',NOW())`, [inviter.accountId, hashInviteToken(token), inviter.owner.id]));
    const user = newUser('late');
    await page.goto(`/signup?invite=${encodeURIComponent(token)}`);
    await page.locator('#fullName').fill('E2E late');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(user.password);
    await page.locator('#confirmPassword').fill(user.password);
    const terms = page.locator('#acceptTerms');
    if (await terms.count()) await terms.check();
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText('Check your email')).toHaveCount(0);
    const exists = await withDb(async (db) => (await db.query('SELECT count(*)::int AS n FROM auth_users WHERE email=$1', [user.email])).rows[0].n);
    expect(exists).toBe(0);
  });
});
