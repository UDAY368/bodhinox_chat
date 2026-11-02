import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { TEMPLATE_EVENTS_CHUNK, listTemplateEvents, normalizeRejectionReason, recordTemplateEvents } from './template-events';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const templateA = randomUUID(), templateB = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

const countFor = async (templateId: string) =>
  (await owner.query('SELECT count(*)::int AS n FROM template_status_events WHERE template_id=$1', [templateId])).rows[0].n as number;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('template status history on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Template events test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Events A',$2),($3,'Events B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, admin, agent, accountB, outsider]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text) VALUES($1,$2,$3,'events_a','Hi'),($4,$5,$6,'events_b','Hi')", [templateA, accountA, admin, templateB, accountB, outsider]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('records only changes against the latest event', async () => {
    expect(await recordTemplateEvents(asAdmin, [{ templateId: templateA, status: 'DRAFT', source: 'draft' }])).toBe(1);
    // Re-saving the same draft adds nothing.
    expect(await recordTemplateEvents(asAdmin, [{ templateId: templateA, status: 'DRAFT', source: 'draft' }])).toBe(0);
    // A failed submit keeps DRAFT but carries a reason: that is a change.
    expect(await recordTemplateEvents(asAdmin, [{ templateId: templateA, status: 'DRAFT', reason: 'Meta said no', source: 'submit' }])).toBe(1);
    expect(await recordTemplateEvents(asAdmin, [{ templateId: templateA, status: 'PENDING', source: 'submit' }])).toBe(1);
    expect(await countFor(templateA)).toBe(3);
  });

  it('lets the worker record webhook events and carries the quality score forward', async () => {
    const asWorker: TenantContext = { accountId: accountA, role: 'owner' };
    expect(await recordTemplateEvents(asWorker, [
      { templateId: templateA, status: 'APPROVED', qualityScore: 'GREEN', source: 'webhook' },
    ], { worker: true })).toBe(1);
    // A status-only event keeps GREEN, so it matches and is skipped.
    expect(await recordTemplateEvents(asAdmin, [{ templateId: templateA, status: 'APPROVED', source: 'sync' }])).toBe(0);
    expect(await recordTemplateEvents(asWorker, [
      { templateId: templateA, status: 'APPROVED', qualityScore: 'YELLOW', source: 'webhook' },
    ], { worker: true })).toBe(1);

    const events = await listTemplateEvents(asAgent, templateA);
    expect(events.map((e) => [e.status, e.quality_score, e.source])).toEqual([
      ['APPROVED', 'YELLOW', 'webhook'],
      ['APPROVED', 'GREEN', 'webhook'],
      ['PENDING', null, 'submit'],
      ['DRAFT', null, 'submit'],
      ['DRAFT', null, 'draft'],
    ]);
    expect(events[3].reason).toBe('Meta said no');
    expect(typeof events[0].created_at).toBe('string');
  });

  it('records a reason-less rejection once across the webhook and a later sync', async () => {
    const asWorker: TenantContext = { accountId: accountA, role: 'owner' };
    // Webhook: REJECTED with no reason; sync: REJECTED with Meta's 'NONE'.
    expect(await recordTemplateEvents(asWorker, [
      { templateId: templateA, status: 'REJECTED', reason: normalizeRejectionReason('REJECTED', undefined), qualityScore: null, source: 'webhook' },
    ], { worker: true })).toBe(1);
    expect(await recordTemplateEvents(asAdmin, [
      { templateId: templateA, status: 'REJECTED', reason: normalizeRejectionReason('REJECTED', 'NONE'), qualityScore: null, source: 'sync' },
    ])).toBe(0);
    const [latest] = await listTemplateEvents(asAdmin, templateA);
    expect([latest.status, latest.reason, latest.source]).toEqual(['REJECTED', null, 'webhook']);
  });

  it('records a catalog larger than one chunk and skips templates that no longer exist', async () => {
    const ids = Array.from({ length: TEMPLATE_EVENTS_CHUNK + 5 }, () => randomUUID());
    await owner.query(
      "INSERT INTO message_templates(id,account_id,user_id,name,body_text) SELECT x, $2, $3, 'bulk_' || x::text, 'Hi' FROM unnest($1::uuid[]) x",
      [ids, accountA, admin],
    );
    const gone = randomUUID();
    const events = [...ids, gone].map((templateId) => ({ templateId, status: 'APPROVED', source: 'sync' as const }));
    expect(await recordTemplateEvents(asAdmin, events)).toBe(ids.length);
    expect(await countFor(gone)).toBe(0);
    // A repeat sync records nothing.
    expect(await recordTemplateEvents(asAdmin, events)).toBe(0);
  });

  it('never writes for members below admin, and swallows the refusal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await countFor(templateA);
    expect(await recordTemplateEvents(asAgent, [{ templateId: templateA, status: 'PAUSED', source: 'edit' }])).toBe(0);
    expect(await countFor(templateA)).toBe(before);
    // Only the error class is logged, never template content.
    expect(error).toHaveBeenCalledWith('[template-events] failed to record status history', expect.any(String));
    error.mockRestore();
  });

  it('keeps each account to its own templates', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await recordTemplateEvents(asB, [{ templateId: templateA, status: 'REJECTED', source: 'webhook' }])).toBe(0);
    expect(await listTemplateEvents(asB, templateA)).toEqual([]);
    expect(await recordTemplateEvents(asB, [{ templateId: templateB, status: 'DRAFT', source: 'draft' }])).toBe(1);
    expect(await listTemplateEvents(asAdmin, templateB)).toEqual([]);
    expect(await listTemplateEvents(asB, templateB)).toHaveLength(1);
    error.mockRestore();
  });
});
