import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { parseInboxSearchParams, searchInboxMessages, type InboxSearchResult } from './search';
import { SNIPPET_END, SNIPPET_START } from './search-snippet';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), maskedA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [adminA, agentA, maskedA, viewerA, ownerB];
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asMasked: TenantContext = { accountId: accountA, userId: maskedA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-7);
const phoneA = `9198${seed}11`;
let owner: pg.Client;
let numberA = '', numberA2 = '';
let convAsha = '', convNoName = '', convB = '';
const msg: Record<string, string> = {};

function search(ctx: TenantContext, query: Record<string, string>): Promise<InboxSearchResult> {
  const input = parseInboxSearchParams(new URLSearchParams(query), ctx.userId!);
  return withTenant(ctx, (tx) => searchInboxMessages(tx, { accountId: ctx.accountId, userId: ctx.userId!, role: ctx.role! }, input));
}

describe.skipIf(!ownerUrl || !appUrl)('inbox message search on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');

    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Search test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Search A',$2),($3,'Search B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES
      ($1,$2,'admin',false),($1,$3,'agent',false),($1,$4,'agent',true),($1,$5,'viewer',false),($6,$7,'owner',false)`,
      [accountA, adminA, agentA, maskedA, viewerA, accountB, ownerB]);
    numberA = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES($1,$2,$3,'not-used') RETURNING id", [accountA, adminA, `pn-s1-${seed}`])).rows[0].id;
    numberA2 = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES($1,$2,$3,'not-used') RETURNING id", [accountA, adminA, `pn-s2-${seed}`])).rows[0].id;

    const contact = async (account: string, user: string, phone: string, name: string | null) =>
      (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id', [account, user, phone, name])).rows[0].id as string;
    const conversation = async (account: string, user: string, contactId: string, number: string | null, status: string, assignee: string | null) =>
      (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id,status,assigned_agent_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [account, user, contactId, number, status, assignee])).rows[0].id as string;
    convAsha = await conversation(accountA, adminA, await contact(accountA, adminA, `+${phoneA}`, 'Asha'), numberA, 'open', agentA);
    convNoName = await conversation(accountA, adminA, await contact(accountA, adminA, `9198${seed}22`, null), numberA2, 'closed', null);
    convB = await conversation(accountB, ownerB, await contact(accountB, ownerB, `9198${seed}33`, 'Bea'), null, 'open', null);

    const message = async (key: string, account: string, conv: string, text: string, at: string) => {
      msg[key] = (await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_text,created_at) VALUES($1,$2,'customer',$3,$4) RETURNING id",
        [account, conv, text, at])).rows[0].id;
    };
    await message('refund1', accountA, convAsha, 'Where is my refund for the late order?', '2026-11-01T09:00:00Z');
    await message('refund2', accountA, convAsha, 'Refund <script>alert(1)</script> \uE000please\uE001', '2026-11-01T10:00:00Z');
    await message('ok', accountA, convAsha, 'ok', '2026-11-01T11:00:00Z');
    await message('pct', accountA, convAsha, 'I got 50% off', '2026-11-01T11:30:00Z');
    await message('noname', accountA, convNoName, 'refund requested again', '2026-11-01T12:00:00Z');
    await message('nonameLast', accountA, convNoName, 'thanks', '2026-11-01T13:00:00Z');
    await message('typedPhone', accountA, convAsha, `call me on 98${seed}11 please`, '2026-11-01T14:00:00Z');
    await message('refundB', accountB, convB, 'refund secret from account B', '2026-11-01T12:30:00Z');
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('finds full-text matches newest first, inside the account only, with marked snippets', async () => {
    const out = await search(asViewer, { q: 'refund' });
    expect(out.mode).toBe('fulltext');
    expect(out.results.map((r) => r.message_id)).toEqual([msg.noname, msg.refund2, msg.refund1]);
    expect(out.results[2]).toMatchObject({ conversation_id: convAsha, contact_name: 'Asha', created_at: '2026-11-01T09:00:00.000Z' });
    expect(out.results[2].snippet).toContain(`${SNIPPET_START}refund${SNIPPET_END}`);
    // Markers already in content are stripped so only real matches are marked; ts_headline drops tags.
    expect(out.results[1].snippet.startsWith(`${SNIPPET_START}Refund${SNIPPET_END}`)).toBe(true);
    expect(out.results[1].snippet).toMatch(/alert\(1\)\s+please$/);
    expect(out.results[1].snippet).not.toContain('<script>');
    expect((await search(asB, { q: 'refund' })).results.map((r) => r.message_id)).toEqual([msg.refundB]);
  });

  it('supports websearch syntax', async () => {
    expect((await search(asAgent, { q: '"late order"' })).results.map((r) => r.message_id)).toEqual([msg.refund1]);
    expect((await search(asAgent, { q: 'refund -late' })).results.map((r) => r.message_id)).toEqual([msg.noname, msg.refund2]);
  });

  it('pages with a keyset cursor', async () => {
    const first = await search(asAgent, { q: 'refund', limit: '2' });
    expect(first.results.map((r) => r.message_id)).toEqual([msg.noname, msg.refund2]);
    const second = await search(asAgent, { q: 'refund', limit: '2', cursor: first.next_cursor! });
    expect(second.results.map((r) => r.message_id)).toEqual([msg.refund1]);
    expect(second.next_cursor).toBeNull();
  });

  it('applies number, status, assignee and date filters', async () => {
    const ids = async (q: Record<string, string>) => (await search(asAgent, { q: 'refund', ...q })).results.map((r) => r.message_id);
    expect(await ids({ whatsapp_config_id: numberA2 })).toEqual([msg.noname]);
    expect(await ids({ status: 'open' })).toEqual([msg.refund2, msg.refund1]);
    expect(await ids({ status: 'pending' })).toEqual([]);
    expect(await ids({ assignee: 'me' })).toEqual([msg.refund2, msg.refund1]);
    expect(await ids({ assignee: 'unassigned' })).toEqual([msg.noname]);
    expect(await ids({ from: '2026-11-01T09:30:00Z', to: '2026-11-01T12:00:00Z' })).toEqual([msg.refund2]);
  });

  it('falls back to a substring match for very short queries and escapes LIKE wildcards', async () => {
    const short = await search(asAgent, { q: 'ok' });
    expect(short.mode).toBe('contains');
    expect(short.results.map((r) => r.message_id)).toEqual([msg.ok]);
    expect(short.results[0].snippet).toBe(`${SNIPPET_START}ok${SNIPPET_END}`);
    expect((await search(asAgent, { q: '0%' })).results.map((r) => r.message_id)).toEqual([msg.pct]);
    expect((await search(asAgent, { q: 'o_' })).results).toEqual([]);
  });

  it('matches phone numbers in text and, for unmasked members, the contact number', async () => {
    const typed = await search(asAgent, { q: `98${seed}11` });
    expect(typed.mode).toBe('phone');
    // The typed number, plus the latest message of Asha's conversation (whose contact number contains it).
    expect(typed.results.map((r) => r.message_id)).toEqual([msg.typedPhone]);
    const byContact = await search(asAgent, { q: `9198${seed}22` });
    expect(byContact.results.map((r) => r.message_id)).toEqual([msg.nonameLast]);
    expect(byContact.results[0].contact_name).toBe(`9198${seed}22`);
    expect((await search(asB, { q: `9198${seed}22` })).results).toEqual([]);
  });

  it('never reveals or matches contact numbers for a masked member', async () => {
    expect((await search(asMasked, { q: `9198${seed}22` })).results).toEqual([]);
    const out = await search(asMasked, { q: 'refund' });
    const noName = out.results.find((r) => r.message_id === msg.noname)!;
    expect(noName.contact_name).toContain('•');
    expect(JSON.stringify(out)).not.toContain(`9198${seed}22`);
    // Admins are never masked, even with the flag set.
    await owner.query('UPDATE account_memberships SET mask_phone_numbers=true WHERE account_id=$1 AND user_id=$2', [accountA, adminA]).catch(() => undefined);
    const admin = await search(asAdmin, { q: 'refund' });
    expect(admin.results.find((r) => r.message_id === msg.noname)!.contact_name).toBe(`9198${seed}22`);
  });
});
