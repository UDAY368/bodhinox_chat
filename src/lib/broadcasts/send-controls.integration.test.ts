// Campaign send controls (batch 7) on PostgreSQL: skip people messaged recently, CSV consent, quiet hours,
// cancel remaining (never touches sent rows; ambiguous ones stay for reconciliation), segments from a
// result, and drafts that keep every field (tenancy and roles).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError, AudienceNotFoundError } from '@/lib/audience/filter';
import { campaignReach, createCampaign } from './create-campaign';
import { cancelRemainingBroadcast, broadcastHalted } from './pause';
import { createResultSegment } from './result-segment';
import { deleteCampaignDraft, loadCampaignDraft, saveCampaignDraft } from './drafts';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), other = randomUUID(), agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const templateId = randomUUID(), tagId = randomUUID();
const fresh = randomUUID(), recent = randomUUID(), old = randomUUID(), failedOnly = randomUUID();
const a: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const v: TenantContext = { accountId: account, userId: viewer, role: 'viewer' };
const b: TenantContext = { accountId: other, userId: outsider, role: 'owner' };
let owner: pg.Client;
const variables = { '1': { type: 'field' as const, value: 'name' as const } };

/** A past campaign sent to `contact` `daysAgo` days ago with a final status. */
async function pastSend(contact: string, daysAgo: number, status: string) {
  const id = randomUUID();
  await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$2,$3,$4,'skip_tpl','sent')", [id, account, agent, `Past ${id}`]);
  await owner.query(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at)
    VALUES($1,$2,$3,$4,now()-make_interval(days=>$5::int))`, [account, id, contact, status, daysAgo]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('campaign send controls on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Send controls', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Controls A',$2),($3,'Controls B',$4)", [account, agent, other, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'viewer'),($4,$5,'owner')", [account, agent, viewer, other, outsider]);
    await owner.query("INSERT INTO workspace_inbox_settings(account_id,timezone) VALUES($1,'Asia/Kolkata')", [account]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'skip_tpl','Hi {{1}}','APPROVED')", [templateId, account, agent]);
    await owner.query("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'Controls')", [tagId, account, agent]);
    await owner.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) SELECT x.id,$1,$2,'Controls '||x.n,'1415888000'||x.n
      FROM unnest($3::uuid[]) WITH ORDINALITY AS x(id,n)`, [account, agent, [fresh, recent, old, failedOnly]]);
    await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) SELECT $1,x,$2 FROM unnest($3::uuid[]) x', [account, tagId, [fresh, recent, old, failedOnly]]);
    await pastSend(recent, 2, 'delivered');
    await pastSend(old, 30, 'read');
    // A send Meta failed never counts as "messaged".
    await pastSend(failedOnly, 1, 'failed');
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('skip people messaged in the last X days: the reach count and the created recipients agree', async () => {
    const audience = { type: 'tags' as const, tagIds: [tagId] };
    expect((await campaignReach(a, { audience })).count).toBe(4);
    const reach = await campaignReach(a, { audience: { ...audience, skipRecentDays: 7 } });
    expect(reach).toEqual({ count: 3, timeZone: 'Asia/Kolkata' });
    const created = await createCampaign(a, { name: `Skip ${randomUUID()}`, templateId, variables, audience: { ...audience, skipRecentDays: 7 } });
    const recipients = (await owner.query('SELECT contact_id FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY contact_id', [created.id])).rows.map((r) => r.contact_id);
    expect(recipients.sort()).toEqual([fresh, old, failedOnly].sort());
    expect((await owner.query('SELECT skip_recent_days FROM broadcasts WHERE id=$1', [created.id])).rows[0].skip_recent_days).toBe(7);
    // A wider window also leaves out the contact sent 30 days ago.
    expect((await campaignReach(a, { audience: { ...audience, skipRecentDays: 31 } })).count).toBe(2);
  });

  it('a CSV audience needs the consent tick, and records who confirmed it', async () => {
    const csv = { type: 'csv' as const, csvContacts: [{ phone: '+14158880001', name: 'Controls 1' }] };
    await expect(createCampaign(a, { name: 'No consent', templateId, variables, audience: csv })).rejects.toMatchObject({ status: 400 });
    await expect(createCampaign(a, { name: 'Wrong consent', templateId, variables, audience: { type: 'all', consentConfirmed: true } })).rejects.toMatchObject({ status: 400 });
    const created = await createCampaign(a, { name: `Consent ${randomUUID()}`, templateId, variables, audience: { ...csv, consentConfirmed: true } });
    const row = (await owner.query('SELECT csv_consent_user_id,csv_consent_at FROM broadcasts WHERE id=$1', [created.id])).rows[0];
    expect(row.csv_consent_user_id).toBe(agent);
    expect(row.csv_consent_at).toBeInstanceOf(Date);
    const plain = await createCampaign(a, { name: `No CSV ${randomUUID()}`, templateId, variables, audience: { type: 'tags', tagIds: [tagId] } });
    expect((await owner.query('SELECT csv_consent_user_id FROM broadcasts WHERE id=$1', [plain.id])).rows[0].csv_consent_user_id).toBeNull();
  });

  it('quiet hours are stored in the workspace time zone and halt a pass outside the window', async () => {
    const created = await createCampaign(a, { name: `Window ${randomUUID()}`, templateId, variables, audience: { type: 'tags', tagIds: [tagId] }, sendWindow: { start: 540, end: 1260 } });
    const row = (await owner.query('SELECT send_window_start,send_window_end,send_window_time_zone FROM broadcasts WHERE id=$1', [created.id])).rows[0];
    expect(row).toEqual({ send_window_start: 540, send_window_end: 1260, send_window_time_zone: 'Asia/Kolkata' });
    // 10:00 UTC = 15:30 IST (inside); 18:00 UTC = 23:30 IST (outside).
    expect(await broadcastHalted(account, created.id, new Date('2026-11-21T10:00:00Z'))).toBe(false);
    expect(await broadcastHalted(account, created.id, new Date('2026-11-21T18:00:00Z'))).toBe(true);
    await expect(createCampaign(a, { name: 'Same', templateId, variables, audience: { type: 'all' }, sendWindow: { start: 540, end: 540 } })).rejects.toMatchObject({ status: 400 });
  });

  it('cancel remaining: unsent rows become Cancelled, sent rows are untouched, ambiguous ones stay for reconciliation', async () => {
    const id = randomUUID();
    await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status,total_recipients) VALUES($1,$2,$3,'Cancel me','skip_tpl','sending',5)", [id, account, agent]);
    const [plain, ambiguous, accepted, sent, failed] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await owner.query(`INSERT INTO broadcast_recipients(id,account_id,broadcast_id,contact_id,status,sent_at) VALUES
      ($1,$6,$7,$8,'pending',NULL),($2,$6,$7,$9,'pending',NULL),($3,$6,$7,$10,'pending',NULL),($4,$6,$7,$11,'sent',now()),($5,$6,$7,$8,'failed',NULL)`,
    [plain, ambiguous, accepted, sent, failed, account, id, fresh, recent, old, failedOnly]);
    // A send whose outcome is unknown, one Meta accepted, and a refused one (refused is safe to cancel).
    await owner.query(`INSERT INTO outbound_intents(account_id,idempotency_key,status) VALUES
      ($1,$2,'unknown'),($1,$3,'accepted'),($1,$4,'failed'),($1,$5,'unknown')`, [account,
      `${account}:broadcast:${id}:${ambiguous}:+14158880002`, `${account}:broadcast:${id}:${accepted}:+14158880003`,
      `${account}:broadcast:${id}:${plain}:+14158880001`, `${account}:broadcast:${id}:${plain}:form-sessions`]);
    await owner.query("INSERT INTO jobs(type,tenant_id,payload,dedupe_key) VALUES('broadcast.dispatch',$1,$2,$3)", [account, JSON.stringify({ broadcastId: id, scope: 'pending' }), `broadcast:${id}:test`]);

    // Another workspace cannot cancel it.
    await expect(cancelRemainingBroadcast(b, id)).rejects.toMatchObject({ status: 404 });
    const result = await cancelRemainingBroadcast(a, id);
    expect(result).toEqual({ cancelled: 1, heldForReview: 2 });
    const rows = Object.fromEntries((await owner.query('SELECT id,status FROM broadcast_recipients WHERE broadcast_id=$1', [id])).rows.map((r) => [r.id, r.status]));
    expect(rows).toEqual({ [plain]: 'cancelled', [ambiguous]: 'pending', [accepted]: 'pending', [sent]: 'sent', [failed]: 'failed' });
    // Intents are never cleared here.
    expect((await owner.query("SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND status IN ('unknown','accepted')", [account])).rows[0].n).toBe(3);
    expect((await owner.query('SELECT status FROM broadcasts WHERE id=$1', [id])).rows[0].status).toBe('cancelled');
    expect((await owner.query('SELECT status FROM jobs WHERE dedupe_key=$1', [`broadcast:${id}:test`])).rows[0].status).toBe('done');
    expect(await broadcastHalted(account, id)).toBe(true);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='campaigns.cancelled_remaining' AND resource_id=$2", [account, id])).rows[0].n).toBe(1);
    // Final: a second cancel or a scheduled campaign is refused (null), not re-run.
    expect(await cancelRemainingBroadcast(a, id)).toBeNull();
  });

  it('creates a live segment from a campaign result, only for this workspace and only once it has sent', async () => {
    const sentId = randomUUID(), draftId = randomUUID();
    await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$3,$4,'Spring sale','skip_tpl','sent'),($2,$3,$4,'Not yet','skip_tpl','draft')", [sentId, draftId, account, agent]);
    const segment = await createResultSegment(a, sentId, 'delivered_not_read');
    expect(segment.name).toBe('Spring sale – Delivered, not read');
    const stored = (await owner.query('SELECT account_id,filter FROM segments WHERE id=$1', [segment.id])).rows[0];
    expect(stored).toEqual({ account_id: account, filter: { conditions: [{ field: 'campaign', broadcastId: sentId, op: 'delivered_not_read' }] } });
    // The same result again gets a numbered name instead of failing.
    expect((await createResultSegment(a, sentId, 'delivered_not_read')).name).toBe('Spring sale – Delivered, not read (2)');
    await expect(createResultSegment(b, sentId, 'failed')).rejects.toBeInstanceOf(AudienceNotFoundError);
    await expect(createResultSegment(a, draftId, 'failed')).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createResultSegment(a, sentId, 'everyone')).rejects.toBeInstanceOf(AudienceFilterError);
    expect((await owner.query('SELECT count(*)::int AS n FROM segments WHERE account_id=$1', [other])).rows[0].n).toBe(0);
  });

  it('a draft keeps every field, replaces in place, and stays inside its workspace and role', async () => {
    const draft = {
      name: 'Draft with everything',
      channel: 'whatsapp' as const,
      templateId,
      variables: { '1': { type: 'csv_column' as const, value: 'first' } },
      headerMediaUrl: 'https://cdn.example.invalid/h.png',
      trackedUrl: 'https://shop.example.invalid/sale',
      sendExtras: { couponCode: 'SAVE10' },
      scheduledAt: '2026-12-01T09:30',
      whatsappConfigId: null,
      sendWindow: { start: 600, end: 1200 },
      audience: {
        type: 'csv' as const, csvFileName: 'leads.csv', consentConfirmed: true, allowDuplicates: true, skipRecentDays: 14,
        excludeTagIds: [tagId], csvContacts: [{ phone: '+14158880009', name: 'Lead', values: { first: 'Lee' } }],
      },
    };
    const { id } = await saveCampaignDraft(a, draft);
    expect(await loadCampaignDraft(a, id)).toEqual({ ...draft, whatsappConfigId: null });
    const row = (await owner.query('SELECT status,template_name,audience_filter FROM broadcasts WHERE id=$1', [id])).rows[0];
    expect(row.status).toBe('draft');
    expect(row.template_name).toBe('skip_tpl');
    // CSV rows never sit on the broadcasts row (realtime events carry it).
    expect(row.audience_filter.csvContacts).toBeUndefined();

    const replaced = await saveCampaignDraft(a, { ...draft, name: 'Renamed', sendWindow: null, audience: { type: 'tags' as const, tagIds: [tagId] } }, id);
    expect(replaced.id).toBe(id);
    const reloaded = await loadCampaignDraft(a, id);
    expect(reloaded).toMatchObject({ name: 'Renamed', sendWindow: null, audience: { type: 'tags', tagIds: [tagId] } });
    expect((await owner.query('SELECT csv_rows FROM broadcast_drafts WHERE broadcast_id=$1', [id])).rows[0].csv_rows).toBeNull();

    // Another workspace sees nothing and changes nothing; a viewer cannot write.
    expect(await loadCampaignDraft(b, id)).toBeNull();
    await expect(saveCampaignDraft(b, draft, id)).rejects.toMatchObject({ status: 400 }); // A's template is not B's
    await expect(saveCampaignDraft(b, { ...draft, templateId: null }, id)).rejects.toMatchObject({ status: 404 });
    expect(await deleteCampaignDraft(b, id)).toBe(false);
    await expect(saveCampaignDraft(v, draft)).rejects.toMatchObject({ status: 403 });
    await expect(deleteCampaignDraft(v, id)).rejects.toMatchObject({ status: 403 });
    // A foreign template id is refused.
    const foreignTemplate = randomUUID();
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'foreign_tpl','Hi','APPROVED')", [foreignTemplate, other, outsider]);
    await expect(saveCampaignDraft(a, { ...draft, templateId: foreignTemplate })).rejects.toMatchObject({ status: 400 });

    // Only a draft can be replaced or removed; removing it takes its saved state with it.
    expect(await deleteCampaignDraft(a, id)).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS n FROM broadcast_drafts WHERE broadcast_id=$1', [id])).rows[0].n).toBe(0);
    const live = randomUUID();
    await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$2,$3,'Live','skip_tpl','sent')", [live, account, agent]);
    await expect(saveCampaignDraft(a, draft, live)).rejects.toMatchObject({ status: 404 });
    expect(await deleteCampaignDraft(a, live)).toBe(false);
    expect(await loadCampaignDraft(a, live)).toBeNull();
  });
});
