// Phase 15 journey helpers: throwaway workspaces, the local SMTP capture, signed
// provider webhooks and the in-spec WhatsApp webhook drain. Everything here
// talks to the isolated test database only (testDatabase refuses any other) or
// to this run's dev server on localhost.
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { argon2id, hash } from 'argon2';
import type pg from 'pg';
import { testDatabase } from './global-setup';
import { MAIL_DIR } from './smtp-capture';
import type { SeededUser } from './fixtures';

/** Must equal the META_APP_SECRET that scripts/e2e-server.cjs gives the dev server (test-only, never a real secret). */
export const E2E_META_APP_SECRET = 'e2e-only-meta-app-secret';

export interface Workspace { accountId: string; name: string; owner: SeededUser }

/** A new workspace with a verified owner who can sign in through the login form. */
export async function seedWorkspace(label: string): Promise<Workspace> {
  const run = randomBytes(4).toString('hex');
  const owner: SeededUser = {
    id: randomUUID(),
    email: `e2e-${run}-${label}@example.invalid`,
    password: `Aa1!${randomBytes(12).toString('base64url')}`,
  };
  const accountId = randomUUID();
  const name = `E2E ${label} ${run}`;
  const passwordHash = await hash(owner.password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  await withDb(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE bodhinox_auth');
      await db.query('INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,NOW())',
        [owner.id, owner.email, `E2E ${label}`, passwordHash]);
      await db.query('INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3)', [accountId, name, owner.id]);
      await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, owner.id]);
      await db.query("INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES($1,$2,$3,$4,'owner')",
        [owner.id, `E2E ${label}`, owner.email, accountId]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
  return { accountId, name, owner };
}

/** Removes workspaces (cascading their data), their jobs and the given users. */
export async function removeWorkspaces(accountIds: string[], userIds: string[] = []) {
  await withDb(async (db) => {
    await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [accountIds]);
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [accountIds]);
    if (userIds.length) await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [userIds]);
  });
}

export async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = await testDatabase();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Polls until `read` returns a value (not undefined/null/false) or the time is up. */
export async function eventually<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > until) throw new Error('Timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The newest captured mail to `address`, decoded (quoted-printable soft breaks removed). */
export async function mailTo(address: string, timeoutMs = 20_000): Promise<string> {
  return eventually(async () => {
    if (!fs.existsSync(MAIL_DIR)) return null;
    const files = fs.readdirSync(MAIL_DIR).sort().reverse();
    for (const file of files) {
      const mail = JSON.parse(fs.readFileSync(path.join(MAIL_DIR, file), 'utf8')) as { to: string[]; data: string };
      if (mail.to.includes(address.toLowerCase())) {
        return mail.data.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      }
    }
    return null;
  }, timeoutMs);
}

/** The first link in a mail that starts with `prefix` (an absolute URL on this run's server). */
export function linkIn(mail: string, prefix: string): string {
  const match = mail.match(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^\\s"<>]+`));
  if (!match) throw new Error('No matching link in the captured mail');
  return match[0];
}

// ---------------------------------------------------------------------------
// Signed webhooks.

export const metaSignature = (raw: string, secret = E2E_META_APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
export const razorpaySignature = (raw: string, secret: string) => createHmac('sha256', secret).update(raw).digest('hex');

/** A WhatsApp Cloud API delivery with one change for `phoneNumberId`. */
export function whatsappDelivery(phoneNumberId: string, value: Record<string, unknown>) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'e2e-waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId }, ...value,
    } }] }],
  });
}

/**
 * Runs the queued `whatsapp.webhook` job of each receipt in a child process
 * (scripts like the worker, but only these jobs), the way the worker would.
 * There is no worker in end-to-end runs.
 */
export function drainWhatsAppReceipts(receiptIds: string[]) {
  const root = process.cwd();
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'e2e/drain-whatsapp.ts'), ...receiptIds], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 90_000,
  });
  if (result.status !== 0) throw new Error(`WhatsApp drain failed: ${(result.stderr || result.stdout || '').slice(-2000)}`);
}
