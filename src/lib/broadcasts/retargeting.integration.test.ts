import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError } from '@/lib/audience/filter';
import { createSegment, previewAudience, segmentContacts } from '@/lib/audience/segments';
import { createCampaign } from './create-campaign';
import { sendCampaignTest } from './test-send';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), other = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const templateId = randomUUID(), plainTemplate = randomUUID(), pastCampaign = randomUUID(), foreignCampaign = randomUUID();
const c = Array.from({ length: 6 }, () => randomUUID());
const a: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const b: TenantContext = { accountId: other, userId: outsider, role: 'owner' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('retargeting, CSV campaigns and test sends on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Retarget test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Retarget A',$2),($3,'Retarget B',$4)", [account, agent, other, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [account, agent, other, outsider]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$3,$4,'order_template','Order {{1}} for {{2}}','APPROVED'),($2,$3,$4,'plain_template','Hello','APPROVED')", [templateId, plainTemplate, account, agent]);
    // c5 is opted out; the rest are marketable.
    await owner.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at) SELECT x.id,$1,$2,'Retarget '||x.n,'1415777000'||x.n,CASE WHEN x.n=5 THEN now() END
      FROM unnest($3::uuid[]) WITH ORDINALITY AS x(id,n)`, [account, agent, c]);
    await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$2,$3,'Past','plain_template','sent'),($4,$5,$6,'Foreign','x','sent')", [pastCampaign, account, agent, foreignCampaign, other, outsider]);
    // c1 read, c2 delivered, c3 sent, c4 failed; c6 was not in the campaign.
    await owner.query(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status) VALUES
      ($1,$2,$3,'read'),($1,$2,$4,'delivered'),($1,$2,$5,'sent'),($1,$2,$6,'failed')`, [account, pastCampaign, c[0], c[1], c[2], c[3]]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[account, other]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[account, other]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const count = async (op: string) => (await previewAudience(a, { filter: { conditions: [{ field: 'campaign', broadcastId: pastCampaign, op }] } })).total;

  it('selects contacts by how they fared in an earlier campaign', async () => {
    expect(await count('received')).toBe(3);
    expect(await count('delivered')).toBe(2);
    expect(await count('read')).toBe(1);
    expect(await count('replied')).toBe(0);
    expect(await count('failed')).toBe(1);
    expect(await count('not_read')).toBe(2);
    // c4 (failed), c5 and c6 (never in it), out of 6 contacts.
    expect(await count('not_received')).toBe(3);
  });

  it('matches nobody, and refuses a saved segment, once the referenced campaign is deleted', async () => {
    const doomed = randomUUID();
    await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$2,$3,'Doomed','plain_template','sent')", [doomed, account, agent]);
    const segment = await createSegment(a, { name: 'Missed doomed', filter: { conditions: [{ field: 'campaign', broadcastId: doomed, op: 'not_received' }] } });
    expect((await previewAudience(a, { segmentId: segment.id })).total).toBe(6);
    await owner.query('DELETE FROM broadcasts WHERE id=$1', [doomed]);
    await expect(previewAudience(a, { segmentId: segment.id })).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createCampaign(a, { name: 'Leak', templateId: plainTemplate, audience: { type: 'segment', segmentId: segment.id }, variables: {} }))
      .rejects.toMatchObject({ status: 400 });
    expect((await segmentContacts(a, segment.id, { offset: 0, limit: 25 })).total).toBe(0);
  });

  it('refuses another workspace\'s campaign in a filter or saved segment', async () => {
    const foreign = { conditions: [{ field: 'campaign', broadcastId: foreignCampaign, op: 'read' }] };
    await expect(previewAudience(a, { filter: foreign })).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createSegment(a, { name: 'Steal', filter: foreign })).rejects.toBeInstanceOf(AudienceFilterError);
    expect(await previewAudience(b, { filter: { conditions: [{ field: 'campaign', broadcastId: pastCampaign, op: 'read' }] } }).catch((e) => e)).toBeInstanceOf(AudienceFilterError);
  });

  it('fills CSV-column variables per row and sends repeated numbers only when allowed', async () => {
    const rows = [
      { phone: '+14157770001', name: 'Retarget 1', values: { order: 'A1', item: 'Shoes' } },
      { phone: '+1 415 777 0001', values: { order: 'A2', item: 'Bag' } },
      { phone: '+14157770005', values: { order: 'A5', item: 'Hat' } },
    ];
    const variables = { '1': { type: 'csv_column' as const, value: 'order' }, '2': { type: 'csv_column' as const, value: 'item' } };
    const params = async (id: string) => (await owner.query('SELECT template_params FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY created_at, template_params::text', [id])).rows.map((r) => r.template_params);

    const once = await createCampaign(a, { name: 'CSV once', templateId, audience: { type: 'csv', csvContacts: rows }, variables });
    expect(await params(once.id)).toEqual([['A1', 'Shoes']]);
    const twice = await createCampaign(a, { name: 'CSV twice', templateId, audience: { type: 'csv', csvContacts: rows, allowDuplicates: true }, variables });
    expect(await params(twice.id)).toEqual([['A1', 'Shoes'], ['A2', 'Bag']]);
    // The opted-out row (c5) is never a recipient.
    await expect(createCampaign(a, { name: 'Bad', templateId, audience: { type: 'all' }, variables })).rejects.toMatchObject({ status: 400 });
    // A mapping to a column the CSV does not have is refused, not sent blank.
    await expect(createCampaign(a, { name: 'Bad', templateId, audience: { type: 'csv', csvContacts: rows },
      variables: { ...variables, '2': { type: 'csv_column', value: 'city' } } })).rejects.toThrow(/no "city" column/);
    await expect(createCampaign(a, { name: 'Bad', templateId, audience: { type: 'all', allowDuplicates: true }, variables: { '1': { type: 'static', value: 'x' }, '2': { type: 'static', value: 'y' } } })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses test sends to opted-out or malformed numbers before contacting WhatsApp', async () => {
    const results = await sendCampaignTest(a, { templateId: plainTemplate, phones: ['+14157770005', '4157770001'], variables: {} });
    expect(results).toEqual([
      { phone: '+14157770005', ok: false, error: 'This number has opted out or is blocked' },
      { phone: '4157770001', ok: false, error: 'Use international format with + and country code' },
    ]);
    // No WhatsApp connection in this workspace: each sendable number says so, nothing is sent.
    expect(await sendCampaignTest(a, { templateId: plainTemplate, phones: ['+14157770001'], variables: {} }))
      .toEqual([{ phone: '+14157770001', ok: false, error: 'WhatsApp is not connected for this workspace' }]);
    await expect(sendCampaignTest(a, { templateId: plainTemplate, phones: ['+1', '+2', '+3', '+4'], variables: {} })).rejects.toMatchObject({ status: 400 });
    await expect(sendCampaignTest(a, { templateId, phones: ['+14157770001'], variables: {} })).rejects.toThrow(/Map every template variable/);
    await expect(sendCampaignTest(b, { templateId: plainTemplate, phones: ['+14157770001'], variables: {} })).rejects.toMatchObject({ status: 404 });
  });
});
