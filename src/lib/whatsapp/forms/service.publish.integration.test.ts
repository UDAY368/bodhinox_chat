import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const meta = vi.hoisted(() => ({
  createFlow: vi.fn(),
  updateFlowMetadata: vi.fn(),
  uploadFlowJson: vi.fn(),
  publishFlow: vi.fn(),
  deprecateFlow: vi.fn(),
  deleteFlow: vi.fn(),
  getFlow: vi.fn(),
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  ...meta,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-token', encrypt: (v: string) => v }));
const tenant = vi.hoisted(() => ({ fail: null as null | ((call: number) => 'before' | 'after' | null), calls: 0 }));
vi.mock('@/lib/db/tenant', async (original) => {
  const real = await original<typeof import('@/lib/db/tenant')>();
  const withTenant: typeof real.withTenant = async (ctx, fn) => {
    const mode = tenant.fail?.(++tenant.calls) ?? null;
    if (mode === 'before') throw new Error('connection reset');
    const result = await real.withTenant(ctx, fn);
    if (mode === 'after') throw new Error('commit acknowledgement lost');
    return result;
  };
  return { ...real, withTenant };
});

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { FormServiceError, createForm, publishForm, updateForm } from './service';
import type { FormDefinition } from './types';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'http://localhost:3000';

const account = randomUUID(), admin = randomUUID();
const asAdmin: TenantContext = { accountId: account, userId: admin, role: 'admin' };
let owner: pg.Client;

const definition = (fieldId: string): FormDefinition => ({
  version: 1,
  screens: [{ id: 'DETAILS', title: 'Your details', button_label: 'Send', fields: [{ id: fieldId, type: 'short_text', label: 'Name', required: true }] }],
});
const refusal = async (promise: Promise<unknown>): Promise<FormServiceError> => {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FormServiceError);
  return err as FormServiceError;
};
const row = (id: string) => owner.query('SELECT * FROM whatsapp_forms WHERE id=$1', [id]).then((r) => r.rows[0]);
const fieldIdsOf = (flowJson: unknown) => JSON.stringify(flowJson).match(/"name":"(\w+)"/g) ?? [];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp forms publish lifecycle on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid, $2, 'Publish test', 'test-only-hash')", [admin, `${admin}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Forms publish',$2)", [account, admin]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [account, admin]);
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,'test-only-encrypted-token','connected')",
      [account, admin, randomUUID(), `waba-${randomUUID()}`]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM audit_logs WHERE account_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [admin]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  beforeEach(() => {
    tenant.fail = null;
    tenant.calls = 0;
    for (const fn of Object.values(meta)) fn.mockReset();
    meta.createFlow.mockResolvedValue({ id: 'flow-1' });
    meta.uploadFlowJson.mockResolvedValue({ validation_errors: [] });
    meta.publishFlow.mockResolvedValue(undefined);
    meta.getFlow.mockResolvedValue({ status: 'PUBLISHED', validation_errors: [] });
    meta.deleteFlow.mockResolvedValue(undefined);
  });

  it('R6: an edit saved while Meta publishes is never recorded as published, and a retry refuses the mismatch', async () => {
    const form = await createForm(asAdmin, { name: 'Raced', category: 'SURVEY', definition: definition('first_name') });
    // A second admin saves a new definition while the upload is in flight.
    meta.uploadFlowJson.mockImplementationOnce(async () => {
      await updateForm(asAdmin, form.id, { definition: definition('given_name') });
      return { validation_errors: [] };
    });
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(409);
    expect(meta.publishFlow).toHaveBeenCalledTimes(1);
    let stored = await row(form.id);
    expect(stored.status).toBe('draft');
    expect(stored.definition.screens[0].fields[0].id).toBe('given_name');
    // flow_json still records what Meta serves.
    expect(fieldIdsOf(stored.flow_json)).toContain('"name":"first_name"');

    // Retry: Meta reports PUBLISHED, but its Flow JSON is not the current definition.
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(409);
    expect(meta.uploadFlowJson).toHaveBeenCalledTimes(1);
    expect((await row(form.id)).status).toBe('draft');

    // Undoing the edit lets the retry record the published flow.
    await updateForm(asAdmin, form.id, { definition: definition('first_name') });
    expect((await publishForm(asAdmin, form.id)).status).toBe('published');
    stored = await row(form.id);
    expect(fieldIdsOf(stored.flow_json)).toContain('"name":"first_name"');
    expect(meta.createFlow).toHaveBeenCalledTimes(1);
  });

  it('R6: an edit after a crash past publishFlow is refused on retry instead of being recorded', async () => {
    const form = await createForm(asAdmin, { name: 'Crashed late', category: 'SURVEY', definition: definition('email') });
    // Simulate the crash: the final local write fails after Meta published.
    tenant.fail = (call) => (call === 4 ? 'before' : null);
    await expect(publishForm(asAdmin, form.id)).rejects.toThrow();
    expect((await row(form.id)).status).toBe('draft');
    tenant.fail = null;
    await updateForm(asAdmin, form.id, { definition: definition('phone') });
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(409);
    expect((await row(form.id)).status).toBe('draft');
  });

  it('R7: a failed flow id write deletes the new Meta flow, and the retry tracks exactly one flow', async () => {
    const form = await createForm(asAdmin, { name: 'Lost id', category: 'SURVEY', definition: definition('city') });
    meta.createFlow.mockResolvedValueOnce({ id: 'flow-orphan' }).mockResolvedValueOnce({ id: 'flow-kept' });
    tenant.fail = (call) => (call === 2 ? 'before' : null);
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(502);
    expect(meta.deleteFlow).toHaveBeenCalledWith({ flowId: 'flow-orphan', accessToken: 'plain-token' });
    expect(meta.uploadFlowJson).not.toHaveBeenCalled();
    expect((await row(form.id)).meta_flow_id).toBeNull();

    tenant.fail = null;
    expect(await publishForm(asAdmin, form.id)).toMatchObject({ status: 'published', meta_flow_id: 'flow-kept' });
    expect(meta.createFlow).toHaveBeenCalledTimes(2);
    expect(meta.deleteFlow).toHaveBeenCalledTimes(1);
  });

  it('R7: a flow id write that committed despite an error is kept, not deleted', async () => {
    const form = await createForm(asAdmin, { name: 'Ambiguous id', category: 'SURVEY', definition: definition('zip') });
    meta.createFlow.mockResolvedValueOnce({ id: 'flow-committed' });
    tenant.fail = (call) => (call === 2 ? 'after' : null);
    expect(await publishForm(asAdmin, form.id)).toMatchObject({ status: 'published', meta_flow_id: 'flow-committed' });
    expect(meta.deleteFlow).not.toHaveBeenCalled();
  });

  it('R7: when the outcome cannot be read back, the new flow is kept rather than risk a dangling id', async () => {
    const form = await createForm(asAdmin, { name: 'Unknown id', category: 'SURVEY', definition: definition('age') });
    meta.createFlow.mockResolvedValueOnce({ id: 'flow-unknown' });
    tenant.fail = (call) => (call === 2 || call === 3 ? 'before' : null);
    await expect(publishForm(asAdmin, form.id)).rejects.toThrow();
    expect(meta.deleteFlow).not.toHaveBeenCalled();
  });
});
