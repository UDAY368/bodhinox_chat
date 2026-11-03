import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { campaignCostComparison, estimateAudienceCost } from './campaign-cost';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), userA = randomUUID(), userB = randomUUID();
const [inOk, inOptedOut, us, gb, contactB] = Array.from({ length: 5 }, () => randomUUID());
const tag = randomUUID(), templateA = randomUUID(), templateB = randomUUID(), campaignA = randomUUID(), campaignB = randomUUID();
const ctxA: TenantContext = { accountId: A, userId: userA, role: 'agent' };
const currency = 'XXX'; // ISO 4217 "no currency": never a real rate.
const seed = `${Date.now()}`.slice(-6);
const phone = (cc: string, n: number) => `${cc}${seed}${String(n).padStart(4, '0')}`;
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('campaign cost estimates on PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Cost', 'test-only-hash' FROM unnest($1::uuid[]) x", [[userA, userB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Cost A',$2),($3,'Cost B',$4)", [A, userA, B, userB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [A, userA, B, userB]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at) VALUES
      ($1,$6,$7,'In',$9,NULL),($2,$6,$7,'Out',$10,now()),($3,$6,$7,'Us',$11,NULL),($4,$6,$7,'Gb',$12,NULL),($5,$8,$13,'B',$14,NULL)`,
      [inOk, inOptedOut, us, gb, contactB, A, userA, B, phone('91', 1), phone('91', 2), phone('1', 3), phone('44', 4), userB, phone('91', 5)]);
    await q("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'vip')", [tag, A, userA]);
    await q('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$4),($1,$3,$4)', [A, inOk, inOptedOut, tag]);
    await q(`INSERT INTO message_templates(id,account_id,user_id,name,category,body_text,status) VALUES
      ($1,$3,$4,'cost_promo','Marketing','Hi','APPROVED'),($2,$5,$6,'cost_promo','Marketing','Hi','APPROVED')`, [templateA, templateB, A, userA, B, userB]);
    await q(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$3,$4,'A','cost_promo','sent'),($2,$5,$6,'B','cost_promo','sent')`,
      [campaignA, campaignB, A, userA, B, userB]);
    await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at) VALUES
      ($1,$2,$3,'read',now()),($1,$2,$4,'sent',now()),($1,$2,$5,'failed',NULL),($6,$7,$8,'delivered',now())`,
      [A, campaignA, inOk, us, gb, B, campaignB, contactB]);
    await q(`INSERT INTO rate_cards(category,country_code,currency,price_minor) VALUES('marketing','IN',$1,100.5),('marketing','US',$1,250),('utility','GB',$1,1)`, [currency]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM rate_cards WHERE currency=$1', [currency]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[userA, userB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('estimates the whole audience by country, skipping opted-out contacts and naming unpriced countries', async () => {
    const e = await estimateAudienceCost(ctxA, { templateId: templateA, audience: { type: 'all' }, currency });
    expect(e).toMatchObject({ category: 'marketing', recipients: 3, capped: false, currency, total: 350.5,
      byCountry: [{ countryCode: 'IN', recipients: 1, unitPriceMinor: 100.5, totalMinor: 100.5 }, { countryCode: 'US', recipients: 1, unitPriceMinor: 250, totalMinor: 250 }],
      missingCountries: [{ countryCode: 'GB', recipients: 1 }] });
    expect(e.currencies).toContain(currency);
  });

  it('uses the campaign audience rules for tags and CSV without writing contacts', async () => {
    const tagged = await estimateAudienceCost(ctxA, { templateId: templateA, audience: { type: 'tags', tagIds: [tag] }, currency });
    expect(tagged.byCountry).toEqual([{ countryCode: 'IN', recipients: 1, unitPriceMinor: 100.5, totalMinor: 100.5 }]);
    const before = (await q('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [A])).rows[0].n;
    const csv = await estimateAudienceCost(ctxA, { templateId: templateA, currency, audience: { type: 'csv', csvContacts: [
      { phone: `+${phone('91', 1)}` }, { phone: `+${phone('91', 1)}` }, { phone: `+${phone('91', 2)}` }, { phone: `+${phone('91', 9)}` }, { phone: '+14155550123' }, { phone: 'abc' },
    ] } });
    expect(csv.byCountry.map((c) => [c.countryCode, c.recipients])).toEqual([['IN', 2], ['US', 1]]);
    expect((await q('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [A])).rows[0].n).toBe(before);
  });

  it('never reads another workspace', async () => {
    await expect(estimateAudienceCost(ctxA, { templateId: templateB, audience: { type: 'all' }, currency })).rejects.toMatchObject({ status: 404 });
    expect(await campaignCostComparison(ctxA, campaignB, currency)).toBeNull();
  });

  it('compares estimated recipients with delivered messages by country', async () => {
    const c = await campaignCostComparison(ctxA, campaignA, currency);
    expect(c).toMatchObject({ category: 'marketing', currency, estimatedTotal: 350.5, actualTotal: 100.5, countries: [
      { countryCode: 'GB', recipients: 1, sent: 0, delivered: 0, unitPriceMinor: null, estimatedMinor: null, actualMinor: null },
      { countryCode: 'IN', recipients: 1, sent: 1, delivered: 1, unitPriceMinor: 100.5, estimatedMinor: 100.5, actualMinor: 100.5 },
      { countryCode: 'US', recipients: 1, sent: 1, delivered: 0, unitPriceMinor: 250, estimatedMinor: 250, actualMinor: 0 },
    ] });
  });
});
