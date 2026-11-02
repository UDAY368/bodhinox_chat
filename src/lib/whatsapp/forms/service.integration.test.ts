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

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import {
  FormServiceError,
  createForm,
  deleteForm,
  duplicateForm,
  exportResponsesCsv,
  getForm,
  listForms,
  listResponses,
  parseFormInput,
  publishForm,
  updateForm,
} from './service';
import type { FormDefinition } from './types';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'http://localhost:3000';

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const contactA = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

const definition: FormDefinition = {
  version: 1,
  screens: [{
    id: 'DETAILS',
    title: 'Your details',
    button_label: 'Send',
    fields: [
      { id: 'name', type: 'short_text', label: 'Name', required: true },
      { id: 'plan', type: 'radio', label: 'Plan', options: [{ id: 'basic', title: 'Basic' }, { id: 'pro', title: 'Pro' }] },
    ],
  }],
};
const refusal = async (promise: Promise<unknown>): Promise<FormServiceError> => {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FormServiceError);
  return err as FormServiceError;
};
const row = (id: string) => owner.query('SELECT * FROM whatsapp_forms WHERE id=$1', [id]).then((r) => r.rows[0]);
const addResponse = (formId: string, messageId: string, response: object, contactId: string | null = contactA) =>
  withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO whatsapp_form_responses(form_id,contact_id,message_id,response)
    VALUES(${formId}::uuid,${contactId}::uuid,${messageId},${JSON.stringify(response)}::jsonb)`);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp forms service on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Forms service test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[admin, agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Forms svc A',$2),($3,'Forms svc B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [accountA, admin, agent, viewer, accountB, outsider]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,phone,name) VALUES($1,$2,$3,'15550002222','=HYPERLINK(\"x\")')", [contactA, accountA, admin]);
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,'test-only-encrypted-token','connected')",
      [accountA, admin, randomUUID(), `waba-${randomUUID()}`]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });
  beforeEach(() => {
    for (const fn of Object.values(meta)) fn.mockReset();
    meta.createFlow.mockResolvedValue({ id: 'flow-1' });
    meta.uploadFlowJson.mockResolvedValue({ validation_errors: [] });
    meta.publishFlow.mockResolvedValue(undefined);
    meta.getFlow.mockResolvedValue({ status: 'PUBLISHED', validation_errors: [], preview_url: 'https://business.facebook.com/wa/manage/flows/x/preview' });
    meta.deleteFlow.mockResolvedValue(undefined);
    meta.deprecateFlow.mockResolvedValue(undefined);
  });

  it('creates, lists and reads forms within the account only', async () => {
    const form = await createForm(asAdmin, parseFormInput({ name: 'Signup', category: 'SIGN_UP' }, false));
    expect(form).toMatchObject({ name: 'Signup', status: 'draft', meta_flow_id: null, uses_endpoint: false });
    expect(form.definition.screens).toHaveLength(1);
    expect((await refusal(createForm(asAdmin, { name: 'Signup', category: 'OTHER' }))).status).toBe(409);
    await expect(createForm(asAgent, { name: 'Agent form', category: 'OTHER' })).rejects.toThrow();

    const listed = await listForms(asViewer);
    expect(listed.find((f) => f.id === form.id)).toMatchObject({ name: 'Signup', response_count: 0 });
    expect((await getForm(asViewer, form.id)).id).toBe(form.id);
    expect(await listForms(asB)).toEqual([]);
    expect((await refusal(getForm(asB, form.id))).status).toBe(404);
    expect((await refusal(updateForm(asB, form.id, { name: 'stolen' }))).status).toBe(404);
    expect((await refusal(deleteForm(asB, form.id))).status).toBe(404);
    expect((await refusal(getForm(asAdmin, 'not-a-uuid'))).status).toBe(404);
  });

  it('validates definitions and locks published forms', async () => {
    expect((() => { try { parseFormInput({ definition: { version: 1, screens: [] } }, true); } catch (e) { return (e as FormServiceError).status; } })()).toBe(422);
    const form = await createForm(asAdmin, { name: 'Locked', category: 'SURVEY', definition });
    const edited = await updateForm(asAdmin, form.id, { name: 'Locked 2', definition: { ...definition, success_message: 'Thanks' } });
    expect(edited).toMatchObject({ name: 'Locked 2' });
    expect(edited.definition.success_message).toBe('Thanks');
    await owner.query("UPDATE whatsapp_forms SET status='published', meta_flow_id='flow-locked' WHERE id=$1", [form.id]);
    expect((await refusal(updateForm(asAdmin, form.id, { definition }))).status).toBe(409);
    expect((await refusal(updateForm(asAdmin, form.id, { uses_endpoint: true }))).status).toBe(409);
    expect((await updateForm(asAdmin, form.id, { name: 'Locked 3' })).name).toBe('Locked 3');
    await expect(updateForm(asAgent, form.id, { name: 'agent edit' })).rejects.toThrow();
  });

  it('publishes: create, upload, publish, then read status and preview', async () => {
    const form = await createForm(asAdmin, { name: 'Lead', category: 'LEAD_GENERATION', definition });
    const published = await publishForm(asAdmin, form.id);
    expect(meta.createFlow).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lead', categories: ['LEAD_GENERATION'], accessToken: 'plain-token' }));
    expect(meta.createFlow.mock.calls[0][0].endpointUri).toBeUndefined();
    expect(meta.uploadFlowJson).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'flow-1' }));
    expect(meta.publishFlow).toHaveBeenCalledWith({ flowId: 'flow-1', accessToken: 'plain-token' });
    expect(published).toMatchObject({ status: 'published', meta_flow_id: 'flow-1', validation_errors: null });
    expect(published.preview_url).toContain('preview');
    expect(published.published_at).toBeTruthy();
    expect((published.flow_json as { version: string }).version).toBe('6.3');
    // Publishing again is a no-op that returns the form.
    meta.createFlow.mockClear();
    expect((await publishForm(asAdmin, form.id)).status).toBe('published');
    expect(meta.createFlow).not.toHaveBeenCalled();
  });

  it('refuses to publish without a connected number or, for endpoint forms, an encryption key', async () => {
    const formB = await createForm(asB, { name: 'B form', category: 'OTHER', definition });
    expect((await refusal(publishForm(asB, formB.id))).status).toBe(409);
    const endpoint = await createForm(asAdmin, { name: 'Endpoint', category: 'OTHER', definition, uses_endpoint: true });
    expect((await refusal(publishForm(asAdmin, endpoint.id))).status).toBe(409);
    expect(meta.createFlow).not.toHaveBeenCalled();
    await owner.query("UPDATE whatsapp_config SET forms_private_key_enc='enc', forms_key_uploaded_at=now() WHERE account_id=$1", [accountA]);
    try {
      meta.createFlow.mockResolvedValueOnce({ id: 'flow-endpoint' });
      await publishForm(asAdmin, endpoint.id);
      expect(meta.createFlow.mock.calls[0][0].endpointUri).toBe(`${new URL(process.env.APP_URL!).origin}/api/whatsapp/forms/endpoint/${accountA}`);
    } finally {
      await owner.query('UPDATE whatsapp_config SET forms_private_key_enc=NULL, forms_key_uploaded_at=NULL WHERE account_id=$1', [accountA]);
    }
  });

  it('stores Meta validation errors, and a retry reuses the same Meta flow', async () => {
    const form = await createForm(asAdmin, { name: 'Retry', category: 'SURVEY', definition });
    meta.createFlow.mockResolvedValueOnce({ id: 'flow-retry' });
    meta.uploadFlowJson.mockResolvedValueOnce({ validation_errors: [{ error: 'INVALID_PROPERTY', message: 'bad label' }] });
    const err = await refusal(publishForm(asAdmin, form.id));
    expect(err.status).toBe(422);
    expect(err.errors).toEqual([{ error: 'INVALID_PROPERTY', message: 'bad label' }]);
    expect(meta.publishFlow).not.toHaveBeenCalled();
    const stored = await row(form.id);
    expect(stored).toMatchObject({ status: 'error', meta_flow_id: 'flow-retry' });
    expect(stored.validation_errors).toHaveLength(1);

    // Meta failing mid-publish leaves the flow id recorded too.
    meta.getFlow.mockResolvedValueOnce({ status: 'DRAFT', validation_errors: [] });
    meta.publishFlow.mockRejectedValueOnce(new MetaApiError('Flow cannot be published', { httpStatus: 400 }));
    const failed = await refusal(publishForm(asAdmin, form.id));
    expect(failed.status).toBe(502);
    expect(failed.message).toBe('Flow cannot be published');

    meta.getFlow.mockResolvedValueOnce({ status: 'DRAFT', validation_errors: [] });
    const published = await publishForm(asAdmin, form.id);
    expect(published).toMatchObject({ status: 'published', meta_flow_id: 'flow-retry', validation_errors: null });
    expect(meta.createFlow).toHaveBeenCalledTimes(1);
    expect(meta.updateFlowMetadata).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'flow-retry', name: 'Retry' }));
  });

  it('records a flow Meta already published without uploading again', async () => {
    const form = await createForm(asAdmin, { name: 'Crashed', category: 'SURVEY', definition });
    await owner.query("UPDATE whatsapp_forms SET meta_flow_id='flow-crashed' WHERE id=$1", [form.id]);
    const published = await publishForm(asAdmin, form.id);
    expect(published).toMatchObject({ status: 'published', meta_flow_id: 'flow-crashed' });
    expect(meta.createFlow).not.toHaveBeenCalled();
    expect(meta.uploadFlowJson).not.toHaveBeenCalled();
    expect(meta.publishFlow).not.toHaveBeenCalled();
  });

  it('deletes on Meta first: draft flows are deleted, published ones deprecated, failures keep the row', async () => {
    const local = await createForm(asAdmin, { name: 'Local only', category: 'OTHER' });
    await deleteForm(asAdmin, local.id);
    expect(meta.deleteFlow).not.toHaveBeenCalled();
    expect(await row(local.id)).toBeUndefined();

    const draft = await createForm(asAdmin, { name: 'Meta draft', category: 'OTHER' });
    await owner.query("UPDATE whatsapp_forms SET meta_flow_id='flow-draft' WHERE id=$1", [draft.id]);
    await deleteForm(asAdmin, draft.id);
    expect(meta.deleteFlow).toHaveBeenCalledWith({ flowId: 'flow-draft', accessToken: 'plain-token' });

    const live = await createForm(asAdmin, { name: 'Live', category: 'OTHER', definition });
    await owner.query("UPDATE whatsapp_forms SET meta_flow_id='flow-live', status='published' WHERE id=$1", [live.id]);
    await addResponse(live.id, `wamid.${randomUUID()}`, { name: 'Ana' });
    meta.deprecateFlow.mockRejectedValueOnce(new MetaApiError('nope', { httpStatus: 500 }));
    expect((await refusal(deleteForm(asAdmin, live.id))).status).toBe(502);
    expect(await row(live.id)).toBeDefined();
    // An agent is refused before Meta is called.
    expect((await refusal(deleteForm(asAgent, live.id))).status).toBe(403);
    expect((await refusal(publishForm(asAgent, live.id))).status).toBe(403);
    expect((await refusal(exportResponsesCsv(asAgent, live.id))).status).toBe(403);
    expect(meta.deprecateFlow).toHaveBeenCalledTimes(1);
    await deleteForm(asAdmin, live.id);
    expect(meta.deprecateFlow).toHaveBeenLastCalledWith({ flowId: 'flow-live', accessToken: 'plain-token' });
    expect(await row(live.id)).toBeUndefined();
    // Responses outlive their form.
    const kept = await owner.query('SELECT form_id FROM whatsapp_form_responses WHERE account_id=$1', [accountA]);
    expect(kept.rows.some((r) => r.form_id === null)).toBe(true);
  });

  it('duplicates into a new draft with no Meta state', async () => {
    const source = await createForm(asAdmin, { name: 'Original', category: 'CONTACT_US', definition });
    await owner.query("UPDATE whatsapp_forms SET meta_flow_id='flow-orig', status='published', preview_url='https://x' WHERE id=$1", [source.id]);
    const first = await duplicateForm(asAdmin, source.id);
    const second = await duplicateForm(asAdmin, source.id);
    expect(first).toMatchObject({ name: 'Original (copy)', status: 'draft', meta_flow_id: null, preview_url: null, category: 'CONTACT_US' });
    expect(first.definition).toEqual(definition);
    expect(second.name).toBe('Original (copy 2)');
    expect((await refusal(duplicateForm(asB, source.id))).status).toBe(404);
    await expect(duplicateForm(asAgent, source.id)).rejects.toThrow();
  });

  it('pages responses with contact, answers and labels, and exports formula-safe CSV with an audit row', async () => {
    const form = await createForm(asAdmin, { name: 'Answers', category: 'SURVEY', definition });
    for (let i = 0; i < 3; i++) {
      await addResponse(form.id, `wamid.${randomUUID()}`, { name: i === 2 ? '=cmd|"/c calc"!A1' : `Ana ${i}`, plan: 'pro', flow_token: 'secret-token', extra: 'x' });
    }
    await addResponse(form.id, `wamid.${randomUUID()}`, { name: 'No contact' }, null);

    const first = await listResponses(asViewer, form.id, { limit: 3 });
    expect(first.responses).toHaveLength(3);
    expect(first.next_cursor).toBeTruthy();
    expect(first.responses[0]).toMatchObject({ contact: null, answers: { name: 'No contact' }, labels: { name: 'Name', plan: 'Plan' } });
    expect(first.responses[1].contact).toEqual({ id: contactA, name: '=HYPERLINK("x")', phone: '15550002222' });
    expect(first.responses[1].answers).toEqual({ name: '=cmd|"/c calc"!A1', plan: 'pro' });
    const second = await listResponses(asViewer, form.id, { cursor: first.next_cursor, limit: 3 });
    expect(second.responses).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.responses, ...second.responses].map((r) => r.id)).size).toBe(4);
    expect((await refusal(listResponses(asViewer, form.id, { cursor: 'garbage' }))).status).toBe(400);
    expect((await refusal(listResponses(asB, form.id, {}))).status).toBe(404);
    expect((await listForms(asViewer)).find((f) => f.id === form.id)?.response_count).toBe(4);

    const { csv, rows } = await exportResponsesCsv(asAdmin, form.id);
    expect(rows).toBe(4);
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0].endsWith('"Name","Plan"')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")","15550002222","'=cmd|""/c calc""!A1","Pro"`);
    expect(csv).not.toContain('secret-token');
    const audit = await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='whatsapp_forms.responses_export' AND resource_id=$2", [accountA, form.id]);
    expect(audit.rows).toEqual([{ metadata: { rows: 4 } }]);
    expect((await refusal(exportResponsesCsv(asB, form.id))).status).toBe(404);
  });
});
