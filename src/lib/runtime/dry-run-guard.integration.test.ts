// Real-database proof of the dry-run guard (Phase 12, design §6.1): inside
// withDryRun every withTenant transaction is READ ONLY on any client (writes
// raise SQLSTATE 25006), and enqueueJob/dispatchOnce/safeFetch refuse before
// touching the database or the network. Also covers the capability loader.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { readWorkspaceCapabilities } from '@/lib/flows/capabilities';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { enqueueJob } from '@/lib/jobs/queue';
import { safeFetch } from '@/lib/webhooks/safe-fetch';
import { DryRunSideEffectError, withDryRun } from './dry-run-guard';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID();
const owner = randomUUID();
const ctx = { accountId: A, userId: owner, role: 'owner' as const };
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n);

/** Prisma wraps the driver error; the SQLSTATE or its message must be in there. */
function isReadOnlyViolation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : String(error);
  return /25006|read-only transaction/i.test(text);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('dry-run guard on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid, $2, 'Dry run', 'test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Dry run A',$2)", [A, owner]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [A, owner]);
  });

  afterAll(async () => {
    await q('DELETE FROM jobs WHERE tenant_id=$1', [A]).catch(() => undefined);
    await q('DELETE FROM accounts WHERE id=$1', [A]).catch(() => undefined);
    await q('DELETE FROM auth_users WHERE id=$1', [owner]).catch(() => undefined);
    await db?.end();
    await disconnectDatabases();
  });

  it('makes every tenant transaction read-only, on the app and the worker client', async () => {
    const insertTag = (name: string) => (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
      tx.$executeRaw`INSERT INTO tags(user_id,name) VALUES(${owner}::uuid, ${name})`;
    await withDryRun(async () => {
      await expect(withTenant(ctx, insertTag('dry-app'))).rejects.toSatisfy(isReadOnlyViolation);
      await expect(withTenant(ctx, insertTag('dry-worker'), getWorkerPrisma())).rejects.toSatisfy(isReadOnlyViolation);
      // Reads still work inside the dry run.
      const rows = await withTenant(ctx, (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tags`);
      expect(Number(rows[0].n)).toBe(0);
    });
    expect(await count('SELECT count(*) AS n FROM tags WHERE account_id=$1', [A])).toBe(0);
    // Outside the dry run the same write succeeds: the guard does not leak.
    await withTenant(ctx, insertTag('live'));
    expect(await count('SELECT count(*) AS n FROM tags WHERE account_id=$1', [A])).toBe(1);
  });

  it('refuses jobs, sends and outbound requests before they start', async () => {
    const send = vi.fn(async () => ({ id: 'never' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await withDryRun(async () => {
      await expect(enqueueJob('flow.sweep', { accountId: A }, { tenantId: A, dedupeKey: `dry:${A}` }))
        .rejects.toBeInstanceOf(DryRunSideEffectError);
      await expect(dispatchOnce(A, `dry-test:${A}`, send)).rejects.toBeInstanceOf(DryRunSideEffectError);
      await expect(safeFetch('https://example.com/hook', { method: 'POST', headers: {}, body: '{}' }))
        .rejects.toBeInstanceOf(DryRunSideEffectError);
    });
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await count('SELECT count(*) AS n FROM jobs WHERE tenant_id=$1', [A])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM outbound_intents WHERE account_id=$1', [A])).toBe(0);
  });

  it('reads workspace capabilities as booleans, inside a dry run too', async () => {
    const read = () => withTenant(ctx, (tx) => readWorkspaceCapabilities(tx, A, {}), getWorkerPrisma());
    expect(await read()).toEqual({
      payments: false, appointments: false, ai: false, capi: false, commerce: false, meetings: false, shipping: false,
    });
    await q("INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_x','enc')", [A]);
    await q("INSERT INTO ai_configs(account_id,provider,model,api_key,is_active) VALUES($1,'openai','m','enc',true)", [A]);
    const caps = await withDryRun(read);
    expect(caps).toMatchObject({ payments: true, ai: true, appointments: false, commerce: false });
  });
});
