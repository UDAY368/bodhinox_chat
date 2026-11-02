import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { createCampaign } from '@/lib/broadcasts/create-campaign';
import { AudienceFilterError } from './filter';
import { exportContactsCsv } from './export';
import { createSegment, deleteSegment, listSegments, previewAudience, segmentContacts, updateSegment } from './segments';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const vip = randomUUID(), foreignTag = randomUUID(), tier = randomUUID(), templateId = randomUUID();
const asha = randomUUID(), bilal = randomUUID(), chen = randomUUID(), dina = randomUUID();
const a: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const b: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('segments, export and segment campaigns on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Segment test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Segments A',$2),($3,'Segments B',$4)", [accountA, agent, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'viewer'),($4,$5,'owner')", [accountA, agent, viewer, accountB, outsider]);
    await owner.query("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'VIP'),($4,$5,$6,'Foreign')", [vip, accountA, agent, foreignTag, accountB, outsider]);
    await owner.query("INSERT INTO custom_fields(id,account_id,user_id,field_name) VALUES($1,$2,$3,'Tier')", [tier, accountA, agent]);
    await owner.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,email,created_at,opted_out_at,blocked_at) VALUES
      ($1,$5,$6,'Asha','14155550101','asha@example.invalid','2026-01-10',NULL,NULL),
      ($2,$5,$6,'Bilal','14155550102','=HYPERLINK("x")','2026-03-10','2026-04-01',NULL),
      ($3,$5,$6,'Chen 50%','14155550103',NULL,'2026-05-10',NULL,'2026-05-11'),
      ($4,$5,$6,'Dina','14155550104',NULL,'2026-06-10',NULL,NULL)`, [asha, bilal, chen, dina, accountA, agent]);
    await owner.query('INSERT INTO contact_tags(account_id,contact_id,tag_id) SELECT $1, x, $2 FROM unnest($3::uuid[]) x', [accountA, vip, [asha, bilal, chen]]);
    await owner.query("INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value) VALUES($1,$2,$4,'Gold'),($1,$3,$4,'Silver')", [accountA, asha, bilal, tier]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'segment_template','Hi {{1}}','APPROVED')", [templateId, accountA, agent]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const count = async (conditions: unknown[]) => (await previewAudience(a, { filter: { conditions } })).total;

  it('compiles every operator correctly against real rows', async () => {
    expect(await count([{ field: 'tags', op: 'has_any', tagIds: [vip] }])).toBe(3);
    expect(await count([{ field: 'tags', op: 'has_none', tagIds: [vip] }])).toBe(1);
    expect(await count([{ field: 'custom_field', fieldId: tier, op: 'is', value: 'Gold' }])).toBe(1);
    expect(await count([{ field: 'custom_field', fieldId: tier, op: 'is_not', value: 'Gold' }])).toBe(3);
    expect(await count([{ field: 'custom_field', fieldId: tier, op: 'contains', value: 'ILV' }])).toBe(1);
    expect(await count([{ field: 'custom_field', fieldId: tier, op: 'is_empty' }])).toBe(2);
    expect(await count([{ field: 'name', op: 'contains', value: '50%' }])).toBe(1);
    expect(await count([{ field: 'name', op: 'contains', value: '%' }])).toBe(1);
    expect(await count([{ field: 'email', op: 'is_empty' }])).toBe(2);
    expect(await count([{ field: 'created_at', op: 'after', value: '2026-03-10' }])).toBe(2);
    expect(await count([{ field: 'created_at', op: 'before', value: '2026-03-10' }])).toBe(1);
    expect(await count([{ field: 'opted_out', op: 'is', value: true }])).toBe(1);
    expect(await count([{ field: 'blocked', op: 'is', value: false }])).toBe(3);
    expect(await previewAudience(a, { filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [vip] }] } })).toEqual({ total: 3, sendable: 1 });
  });

  it('saves, pages, renames and deletes a segment, and keeps names unique', async () => {
    const segment = await createSegment(a, { name: 'VIPs', filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [vip] }] } });
    expect((await listSegments(a)).map((s) => s.name)).toEqual(['VIPs']);
    const page = await segmentContacts(a, segment.id, { offset: 0, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.contacts).toHaveLength(2);
    expect((await segmentContacts(a, segment.id, { offset: 0, limit: 25, search: 'ash' })).contacts.map((c) => c.id)).toEqual([asha]);
    await expect(createSegment(a, { name: 'VIPs', filter: { conditions: [{ field: 'name', op: 'is_empty' }] } })).rejects.toBeInstanceOf(AudienceFilterError);
    expect((await updateSegment(a, segment.id, { name: 'Top customers' }))?.name).toBe('Top customers');
    expect(await deleteSegment(a, segment.id)).toBe(true);
    expect(await listSegments(a)).toEqual([]);
  });

  it('isolates segments per workspace and refuses foreign tags, viewers and forged ids', async () => {
    const segment = await createSegment(a, { name: 'Mine', filter: { conditions: [{ field: 'name', op: 'is_not_empty' }] } });
    expect(await listSegments(b)).toEqual([]);
    await expect(segmentContacts(b, segment.id, { offset: 0, limit: 25 })).rejects.toBeInstanceOf(AudienceFilterError);
    expect(await updateSegment(b, segment.id, { name: 'Stolen' })).toBeNull();
    expect(await deleteSegment(b, segment.id)).toBe(false);
    await expect(createSegment(a, { name: 'Foreign', filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [foreignTag] }] } }))
      .rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createSegment({ accountId: accountA, userId: viewer, role: 'viewer' }, { name: 'Viewer', filter: { conditions: [{ field: 'name', op: 'is_empty' }] } }))
      .rejects.toThrow();
    expect(await previewAudience(b, { filter: { conditions: [{ field: 'name', op: 'is_not_empty' }] } })).toEqual({ total: 0, sendable: 0 });
    await deleteSegment(a, segment.id);
  });

  it('lets a viewer preview and page a saved segment (read path takes no row lock)', async () => {
    const asViewer: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
    const segment = await createSegment(a, { name: 'Viewer readable', filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [vip] }] } });
    try {
      expect(await previewAudience(asViewer, { segmentId: segment.id })).toEqual({ total: 3, sendable: 1 });
      const first = await segmentContacts(asViewer, segment.id, { offset: 0, limit: 2 });
      expect(first.total).toBe(3);
      expect(first.contacts).toHaveLength(2);
      const second = await segmentContacts(asViewer, segment.id, { offset: 2, limit: 2 });
      expect(second.contacts).toHaveLength(1);
      expect(new Set([...first.contacts, ...second.contacts].map((c) => c.id))).toEqual(new Set([asha, bilal, chen]));
      // Still refused writes.
      expect(await updateSegment(asViewer, segment.id, { name: 'Viewer rename' }).catch(() => null)).toBeNull();
    } finally {
      await deleteSegment(a, segment.id);
    }
  });

  it('exports a segment as formula-safe CSV and audit-logs the export', async () => {
    const segment = await createSegment(a, { name: 'Export', filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [vip] }] } });
    const { csv, rows } = await exportContactsCsv({ ...a, role: 'admin' }, { segmentId: segment.id });
    expect(rows).toBe(3);
    expect(csv.startsWith('﻿"Name","Phone","Email","Company","Tags"')).toBe(true);
    expect(csv).toContain('"Tier"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"Gold"');
    expect(csv).not.toContain('Dina');
    const audit = (await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='contacts.export'", [accountA])).rows;
    expect(audit).toEqual([{ metadata: { rows: 3 } }]);
    await deleteSegment(a, segment.id);
  });

  it('uses a segment as a campaign audience, still excluding opted-out and blocked contacts', async () => {
    const segment = await createSegment(a, { name: 'Campaign', filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [vip] }] } });
    const result = await createCampaign(a, {
      name: 'Segment campaign', templateId,
      audience: { type: 'segment', segmentId: segment.id },
      variables: { '1': { type: 'field', value: 'name' } },
    });
    const recipients = (await owner.query('SELECT contact_id FROM broadcast_recipients WHERE broadcast_id=$1', [result.id])).rows;
    expect(recipients).toEqual([{ contact_id: asha }]);
    await expect(createCampaign(b, {
      name: 'Forged', templateId: randomUUID(),
      audience: { type: 'segment', segmentId: segment.id },
      variables: {},
    })).rejects.toBeTruthy();
    await deleteSegment(a, segment.id);
  });
});
