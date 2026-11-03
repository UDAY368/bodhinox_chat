import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { conversationAdReferral, ConversationNotFoundError } from './conversation-referral';

// The inbox "Started from ad" lookup on the app role: first referral of the
// conversation, never the click id, and nothing across workspaces.

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID(), userA = randomUUID(), userB = randomUUID();
const asA: TenantContext = { accountId: accountA, userId: userA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: userB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const CLICK_ID = `clid-secret-${seed}`;
let owner: pg.Client;
let fromAd: string, organic: string, contactA: string;

describe.skipIf(!ownerUrl || !appUrl)('conversation ad referral on PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Referral test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[userA, userB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ref A',$2),($3,'Ref B',$4)", [accountA, userA, accountB, userB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'viewer'),($3,$4,'owner')", [accountA, userA, accountB, userB]);
    contactA = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id', [accountA, userA, `+9184${seed}`])).rows[0].id;
    fromAd = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [accountA, userA, contactA])).rows[0].id;
    const contactOrganic = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id', [accountA, userA, `+9185${seed}`])).rows[0].id;
    organic = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status) VALUES($1,$2,$3,'open') RETURNING id", [accountA, userA, contactOrganic])).rows[0].id;
    // Two referrals on one conversation: the first one started it.
    await owner.query(`INSERT INTO ad_referrals(account_id,contact_id,conversation_id,wa_message_id,source_id,source_type,source_url,headline,ctwa_clid,created_at) VALUES
      ($1,$2,$3,$4,'120000000011','ad','https://fb.me/first','First ad',$6, now() - interval '1 hour'),
      ($1,$2,$3,$5,'120000000012','ad','https://fb.me/second','Second ad',$6, now())`,
    [accountA, contactA, fromAd, `wamid.ref.${seed}.1`, `wamid.ref.${seed}.2`, CLICK_ID]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[userA, userB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('returns the first referral of the conversation without the click id', async () => {
    const referral = await conversationAdReferral(asA, fromAd);
    expect(referral).toMatchObject({ headline: 'First ad', sourceUrl: 'https://fb.me/first', sourceType: 'ad' });
    expect(Number.isFinite(Date.parse(referral!.createdAt))).toBe(true);
    expect(JSON.stringify(referral)).not.toContain(CLICK_ID);
  });

  it('returns null for a conversation that did not start from an ad', async () => {
    expect(await conversationAdReferral(asA, organic)).toBeNull();
  });

  it('hides another workspace\'s conversation and refuses malformed ids', async () => {
    await expect(conversationAdReferral(asB, fromAd)).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(conversationAdReferral(asA, randomUUID())).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(conversationAdReferral(asA, "x' OR 1=1")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
