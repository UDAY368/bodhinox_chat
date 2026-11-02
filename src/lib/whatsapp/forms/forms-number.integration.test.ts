// R3: a WhatsApp form belongs to one number and that number's WABA. Meta calls
// use the form's own number (never whichever row Postgres returns first), a
// form is never moved to another WABA once its Meta Flow exists, and the data
// endpoint only opens forms of the WABA whose number holds the decrypting key.
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
// Stored test values are "enc:<plain>"; anything else decrypts to a fixed token.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : 'plain-token'),
  encrypt: (v: string) => `enc:${v}`,
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { FormServiceError, createForm, duplicateForm, publishForm, updateForm } from './service';
import { formsKeyring, formsSessionStore } from './session-store';
import { createFormSession } from './sessions';
import type { FormDefinition } from './types';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'http://localhost:3000';

const account = randomUUID(), other = randomUUID(), admin = randomUUID();
const asAdmin: TenantContext = { accountId: account, userId: admin, role: 'admin' };
const wabaOne = `waba-${randomUUID()}`, wabaTwo = `waba-${randomUUID()}`;
let owner: pg.Client;
// A: default, WABA one, no forms key. A2: WABA one, key. B: WABA two, key.
let numberA = '', numberA2 = '', numberB = '', foreignNumber = '';

const definition: FormDefinition = {
  version: 1,
  screens: [{ id: 'DETAILS', title: 'Your details', button_label: 'Send', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }] }],
};
const refusal = async (promise: Promise<unknown>): Promise<FormServiceError> => {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FormServiceError);
  return err as FormServiceError;
};
const row = (id: string) => owner.query('SELECT * FROM whatsapp_forms WHERE id=$1', [id]).then((r) => r.rows[0]);
const addNumber = async (accountId: string, waba: string, opts: { isDefault?: boolean; key?: string } = {}) =>
  (await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,is_default,
      forms_private_key_enc,forms_key_uploaded_at)
    VALUES($1,$2,$3,$4,'test-only-encrypted-token','connected',$5,$6,CASE WHEN $6::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
  [accountId, admin, randomUUID(), waba, opts.isDefault ?? false, opts.key ? `enc:${opts.key}` : null])).rows[0].id as string;
let seq = 0;
const newForm = (input: { whatsapp_config_id?: string; uses_endpoint?: boolean } = {}) =>
  createForm(asAdmin, { name: `Form ${++seq}`, category: 'LEAD_GENERATION' as never, definition, ...input });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp forms belong to a number and its WABA (R3)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'Forms number test','test-only-hash')", [admin, `${admin}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Forms number',$3),($2,'Forms number other',$3)", [account, other, admin]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [account, admin]);
    numberA = await addNumber(account, wabaOne, { isDefault: true });
    numberA2 = await addNumber(account, wabaOne, { key: 'test-only-key-a2' });
    numberB = await addNumber(account, wabaTwo, { key: 'test-only-key-b' });
    foreignNumber = await addNumber(other, wabaTwo, { isDefault: true });
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[account, other]]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [admin]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  beforeEach(() => {
    for (const fn of Object.values(meta)) fn.mockReset();
    meta.createFlow.mockImplementation(async () => ({ id: `flow-${randomUUID()}` }));
    meta.uploadFlowJson.mockResolvedValue({ validation_errors: [] });
    meta.publishFlow.mockResolvedValue(undefined);
    meta.getFlow.mockResolvedValue({ status: 'PUBLISHED' });
    meta.deleteFlow.mockResolvedValue(undefined);
  });

  it('creates a form on the default number, or the chosen one, never another workspace\'s', async () => {
    const byDefault = await newForm();
    expect(byDefault).toMatchObject({ whatsapp_config_id: numberA, waba_id: wabaOne });
    const chosen = await newForm({ whatsapp_config_id: numberB });
    expect(chosen).toMatchObject({ whatsapp_config_id: numberB, waba_id: wabaTwo });
    expect((await refusal(newForm({ whatsapp_config_id: foreignNumber }))).status).toBe(400);
    expect((await refusal(newForm({ whatsapp_config_id: randomUUID() }))).status).toBe(400);
  });

  it('publishes in the form\'s own WABA, whichever number is the default', async () => {
    const form = await newForm({ whatsapp_config_id: numberB });
    await publishForm(asAdmin, form.id);
    expect(meta.createFlow).toHaveBeenCalledTimes(1);
    expect(meta.createFlow.mock.calls[0][0]).toMatchObject({ wabaId: wabaTwo });
    expect((await row(form.id)).status).toBe('published');
  });

  it('checks the forms key of the form\'s own number before publishing an endpoint form', async () => {
    // Number A has no key although A2 and B do: refused, nothing created on Meta.
    const onA = await newForm({ whatsapp_config_id: numberA, uses_endpoint: true });
    expect((await refusal(publishForm(asAdmin, onA.id))).status).toBe(409);
    expect(meta.createFlow).not.toHaveBeenCalled();
    const onA2 = await newForm({ whatsapp_config_id: numberA2, uses_endpoint: true });
    await publishForm(asAdmin, onA2.id);
    expect(meta.createFlow.mock.calls[0][0]).toMatchObject({ wabaId: wabaOne });
  });

  it('moves a form between WABAs only before its Meta Flow exists', async () => {
    const draft = await newForm();
    expect(await updateForm(asAdmin, draft.id, { whatsapp_config_id: numberB })).toMatchObject({ whatsapp_config_id: numberB, waba_id: wabaTwo });

    const withFlow = await newForm();
    await owner.query("UPDATE whatsapp_forms SET meta_flow_id='flow-existing', status='error' WHERE id=$1", [withFlow.id]);
    expect((await refusal(updateForm(asAdmin, withFlow.id, { whatsapp_config_id: numberB }))).status).toBe(409);
    expect(await row(withFlow.id)).toMatchObject({ whatsapp_config_id: numberA, waba_id: wabaOne });
    // Another number of the same WABA may take it over.
    expect(await updateForm(asAdmin, withFlow.id, { whatsapp_config_id: numberA2 })).toMatchObject({ whatsapp_config_id: numberA2, waba_id: wabaOne });
  });

  it('refuses to record a flow when the form moved to another WABA mid-publish, and deletes that flow', async () => {
    const form = await newForm();
    meta.createFlow.mockImplementation(async () => {
      await owner.query('UPDATE whatsapp_forms SET whatsapp_config_id=$2, waba_id=$3 WHERE id=$1', [form.id, numberB, wabaTwo]);
      return { id: 'flow-moved' };
    });
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(409);
    expect(meta.deleteFlow).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'flow-moved' }));
    expect((await row(form.id)).meta_flow_id).toBeNull();
  });

  it('copies the number on duplicate', async () => {
    const source = await newForm({ whatsapp_config_id: numberB });
    expect(await duplicateForm(asAdmin, source.id)).toMatchObject({ whatsapp_config_id: numberB, waba_id: wabaTwo, meta_flow_id: null });
  });

  it('keeps the WABA when the number is deleted and never falls back to another WABA', async () => {
    const lone = await addNumber(account, `waba-${randomUUID()}`);
    const form = await newForm({ whatsapp_config_id: lone });
    await owner.query('DELETE FROM whatsapp_config WHERE id=$1', [lone]);
    const after = await row(form.id);
    expect(after.whatsapp_config_id).toBeNull();
    expect(after.waba_id).toBe(form.waba_id);
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(409);
    expect(meta.createFlow).not.toHaveBeenCalled();

    // With another number of the same WABA connected, that number is used.
    const sibling = await newForm({ whatsapp_config_id: numberA2 });
    await owner.query('UPDATE whatsapp_forms SET whatsapp_config_id=NULL WHERE id=$1', [sibling.id]);
    await publishForm(asAdmin, sibling.id);
    expect(meta.createFlow.mock.calls[0][0]).toMatchObject({ wabaId: wabaOne });
  });

  it('manages a form whose number was disconnected through another number of the same WABA only', async () => {
    const wabaThree = `waba-${randomUUID()}`;
    const gone = await addNumber(account, wabaThree);
    const form = await newForm({ whatsapp_config_id: gone });
    await owner.query("UPDATE whatsapp_config SET status='disconnected', access_token='' WHERE id=$1", [gone]);
    expect((await refusal(publishForm(asAdmin, form.id))).status).toBe(409);
    expect(meta.createFlow).not.toHaveBeenCalled();
    await addNumber(account, wabaThree);
    await publishForm(asAdmin, form.id);
    expect(meta.createFlow.mock.calls[0][0]).toMatchObject({ wabaId: wabaThree });
    expect(await row(form.id)).toMatchObject({ whatsapp_config_id: gone, waba_id: wabaThree });
  });

  it('rejects a form number from another workspace at the database (composite FK)', async () => {
    await expect(owner.query(`INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition,whatsapp_config_id)
      VALUES($1,$2,'fk probe','OTHER','{}'::jsonb,$3)`, [account, admin, foreignNumber])).rejects.toMatchObject({ code: '23503' });
    await expect(owner.query("UPDATE whatsapp_forms SET waba_id=repeat('x',65) WHERE account_id=$1", [account]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('opens a session only with a key of a number in the form\'s WABA', async () => {
    const keyring = await formsKeyring(account);
    const keyB = keyring.find((k) => k.privateKeyPem === 'test-only-key-b')!;
    const keyA2 = keyring.find((k) => k.privateKeyPem === 'test-only-key-a2')!;
    expect(keyB.wabaIds).toEqual([wabaTwo]);
    expect(keyA2.wabaIds).toEqual([wabaOne]);

    const form = await newForm({ whatsapp_config_id: numberA });
    const { flowToken } = await withTenant(asAdmin, (tx) => createFormSession(tx, {
      accountId: account, formId: form.id, contactId: null, conversationId: null, flowRunId: null, ttlHours: 1,
    }));
    expect(await formsSessionStore(account, { wabaIds: keyB.wabaIds }).find(flowToken)).toBeNull();
    expect(await formsSessionStore(account, { wabaIds: keyA2.wabaIds }).find(flowToken)).toMatchObject({ completed: false });
    expect(await formsSessionStore(account).find(flowToken)).not.toBeNull();
  });
});
