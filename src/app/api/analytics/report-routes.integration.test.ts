import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), B = randomUUID(), userA = randomUUID(), userB = randomUUID();
const numberA = randomUUID(), numberB = randomUUID(), flowA = randomUUID(), flowB = randomUUID();
const seed = `${Date.now()}`.slice(-8);
const h = vi.hoisted(() => ({ session: null as null | { accountId: string; userId: string; role: string } }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ ...h.session, sessionId: 's', user: { id: h.session!.userId, email: 'x@example.invalid', user_metadata: {} } }),
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import { GET as overview } from './overview/route';
import { GET as flows } from './flows/route';
import { GET as agents } from './agents/route';
import { GET as campaigns } from './campaigns/route';
import { GET as ai } from './ai/route';

let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const get = async (handler: (r: Request) => Promise<Response>, path: string) => {
  const res = await handler(new Request(`http://x/api/analytics/${path}`));
  return { status: res.status, body: await res.json() };
};

describe.skipIf(!ownerUrl || !appUrl)('analytics report routes on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Reports', 'test-only-hash' FROM unnest($1::uuid[]) x", [[userA, userB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reports A',$2),($3,'Reports B',$4)", [A, userA, B, userB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES($1,$2,'viewer',true),($3,$4,'owner',false)", [A, userA, B, userB]);
    await q(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,display_name)
      VALUES($1,$2,$3,$4,'secret-a','disconnected','Sales line'),($5,$6,$7,$8,'secret-b','disconnected','Other workspace')`,
    [numberA, A, userA, `91${seed}`, numberB, B, userB, `92${seed}`]);
    await q("INSERT INTO flows(id,account_id,user_id,name,trigger_type,status) VALUES($1,$2,$3,'Welcome A','keyword','active'),($4,$5,$6,'Welcome B','keyword','active')",
      [flowA, A, userA, flowB, B, userB]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[userA, userB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('serves a masked viewer every report but AI, with workspace labels and no numbers or tokens', async () => {
    h.session = { accountId: A, userId: userA, role: 'viewer' };
    const o = await get(overview, `overview?preset=30d&number=${numberA}`);
    expect(o.status).toBe(200);
    expect(o.body.numbers).toEqual([{ id: numberA, label: 'Sales line', isDefault: expect.any(Boolean) }]);
    expect(JSON.stringify(o.body)).not.toMatch(new RegExp(`9[12]${seed}|secret`));
    expect(o.body.current.started.total).toBe(0);
    expect(o.body.previousRange.days).toBe(30);

    const f = await get(flows, 'flows?preset=7d');
    expect(f.status).toBe(200);
    expect(f.body.flows).toEqual([{ id: flowA, name: 'Welcome A' }]);
    expect((await get(agents, 'agents?preset=7d')).body.agents.map((a: { userId: string }) => a.userId)).toEqual([userA]);
    expect((await get(campaigns, 'campaigns?preset=7d')).status).toBe(200);
    expect((await get(ai, 'ai?preset=7d')).status).toBe(403);
  });

  it('keeps another workspace out: a foreign number filter matches nothing', async () => {
    h.session = { accountId: A, userId: userA, role: 'viewer' };
    const o = await get(overview, `overview?preset=today&number=${numberB}`);
    expect(o.status).toBe(200);
    expect(o.body.numbers.map((n: { id: string }) => n.id)).toEqual([numberA]);
    h.session = { accountId: B, userId: userB, role: 'owner' };
    expect((await get(ai, 'ai?preset=7d')).status).toBe(200);
    expect((await get(flows, 'flows')).body.flows).toEqual([{ id: flowB, name: 'Welcome B' }]);
  });
});
