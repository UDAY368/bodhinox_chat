import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  connection: vi.fn(),
  getLead: vi.fn(),
  listLeadForms: vi.fn(),
  listFormLeads: vi.fn(),
  tenants: [] as unknown[],
}));
const sqlText = (strings: TemplateStringsArray) => strings.join('?');
const client = {
  $queryRaw: (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => (Array.isArray(strings)
    ? h.queryRaw(sqlText(strings as TemplateStringsArray), values)
    : h.queryRaw((strings as Prisma.Sql).sql, (strings as Prisma.Sql).values)),
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => h.executeRaw(sqlText(strings), values),
  // Prisma.sql fragments (listLeads) arrive as one Sql object.
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => h.queryRaw(sql, values),
  $transaction: (op: (tx: unknown) => unknown) => op(client),
};
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => client, getPrisma: () => client }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (ctx: unknown, op: (tx: unknown) => unknown) => {
    h.tenants.push(ctx);
    return op(client);
  },
}));
vi.mock('./connection', () => ({ loadActiveConnectionTx: h.connection }));
vi.mock('./graph', async (orig) => ({
  ...(await orig<typeof import('./graph')>()),
  getLead: h.getLead,
  listLeadForms: h.listLeadForms,
  listFormLeads: h.listFormLeads,
}));

import {
  boundFieldData, deleteLead, handleLeadgenFetchJob, handleLeadsSyncJob, handlePageWebhookJob, leadIdentity, LeadsInputError,
  listLeads, parseLeadgenChanges, parseLeadsFilter, parseSyncResume, persistPageWebhook, storeFetchedLeadTx,
} from './leads';

const ACCOUNT = '6f1c2d3e-0000-4000-8000-0000000000aa';
const CONNECTION = '6f1c2d3e-0000-4000-8000-0000000000bb';
const env = { META_ADS_ENABLED: 'true', META_APP_ID: '1', META_APP_SECRET: 's', META_ADS_LOGIN_CONFIG_ID: '2' };
const LEAD_SCOPES = ['leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads'];
const connection = (over: Record<string, unknown> = {}) => ({
  id: CONNECTION, pageId: '111', pageToken: 'PAGE-TOKEN', scopes: LEAD_SCOPES, leadsSyncedAt: null, ...over,
});
const lead = {
  id: '999', createdTime: '2026-11-03T10:00:00+0000', formId: '555', adId: '777', adsetId: null, campaignId: null,
  adName: 'Ad', campaignName: null,
  fieldData: [{ name: 'full_name', values: ['Asha Rao'] }, { name: 'phone_number', values: ['+91 98765 43210'] }],
};
const webhook = (changes: unknown[]) => ({ object: 'page', entry: [{ id: '111', changes }] });
const leadgen = (value: Record<string, unknown>) => ({ field: 'leadgen', value });

beforeEach(() => {
  vi.clearAllMocks();
  h.tenants.length = 0;
  h.queryRaw.mockResolvedValue([]);
  h.executeRaw.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());
const enable = () => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };

describe('parseLeadgenChanges', () => {
  it('keeps well-formed leadgen changes and drops everything else', () => {
    const changes = parseLeadgenChanges(webhook([
      leadgen({ leadgen_id: '999', page_id: '111', form_id: '555', ad_id: '777', created_time: 1762164000 }),
      leadgen({ leadgen_id: 'x', page_id: '111' }),
      { field: 'feed', value: { leadgen_id: '1' } },
      leadgen({ leadgen_id: 1234 }), // page id falls back to the entry id
    ]));
    expect(changes).toEqual([
      { pageId: '111', leadgenId: '999', formId: '555', adId: '777', createdAt: new Date(1762164000 * 1000) },
      { pageId: '111', leadgenId: '1234', formId: null, adId: null, createdAt: null },
    ]);
    expect(parseLeadgenChanges({ object: 'whatsapp_business_account', entry: [] })).toEqual([]);
    expect(parseLeadgenChanges(null)).toEqual([]);
  });
});

describe('answers', () => {
  it('bounds field data under the CHECK size', () => {
    const big = Array.from({ length: 100 }, (_, i) => ({ name: `q${i}`, values: ['x'.repeat(1000)] }));
    const kept = boundFieldData(big);
    expect(kept.length).toBeLessThan(100);
    expect(JSON.stringify(kept).length).toBeLessThan(48_000);
  });

  it('reads phone, name and email; a national-format number is not guessed', () => {
    expect(leadIdentity(lead.fieldData)).toEqual({ phone: '919876543210', name: 'Asha Rao', email: null });
    expect(leadIdentity([{ name: 'first_name', values: ['A'] }, { name: 'last_name', values: ['B'] }, { name: 'email', values: ['a@b.co'] },
      { name: 'phone_number', values: ['9876543210'] }])).toEqual({ phone: null, name: 'A B', email: 'a@b.co' });
  });
});

describe('parseLeadsFilter', () => {
  it('accepts Meta ids and dates, rejects anything else', () => {
    expect(parseLeadsFilter(new URLSearchParams('formId=555&from=2026-11-01'))).toMatchObject({ formId: '555', from: '2026-11-01', adId: null });
    for (const qs of ['formId=act_1', 'adId=1%27%20OR', 'from=2026-13-45x', 'cursor=bad'])
      expect(() => parseLeadsFilter(new URLSearchParams(qs))).toThrow(LeadsInputError);
  });
});

describe('feature off', () => {
  it('every job returns before any SQL or network call', async () => {
    vi.stubEnv('META_ADS_ENABLED', '');
    await handlePageWebhookJob(webhook([leadgen({ leadgen_id: '1', page_id: '111' })]));
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '1' });
    await handleLeadsSyncJob(ACCOUNT, {});
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.executeRaw).not.toHaveBeenCalled();
    expect(h.getLead).not.toHaveBeenCalled();
    expect(h.listLeadForms).not.toHaveBeenCalled();
  });
});

describe('persistPageWebhook', () => {
  it('stores a prefixed receipt and an account-less job in one transaction', async () => {
    h.queryRaw.mockResolvedValueOnce([{ id: 'r1' }]);
    await expect(persistPageWebhook('{"object":"page"}', { object: 'page' })).resolves.toBe('r1');
    const [, values] = h.queryRaw.mock.calls[0];
    expect(values[0]).toBe('meta_page');
    expect(values[1]).toMatch(/^meta_page:[0-9a-f]{64}$/);
    const [jobSql, jobValues] = h.executeRaw.mock.calls[0];
    expect(jobSql).toContain('INSERT INTO jobs(type,payload,dedupe_key)');
    expect(jobValues).toEqual(['meta.page_webhook', JSON.stringify({ receiptId: 'r1' }), 'pagewebhook:r1']);
  });
});

describe('handlePageWebhookJob', () => {
  it('drops unknown Pages without logging ids, and queues a fetch for a known Page', async () => {
    enable();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.queryRaw.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes('crm_resolve_page_account')) return values[0] === '111' ? [{ account_id: ACCOUNT, connection_id: CONNECTION }] : [];
      if (sql.includes('INSERT INTO meta_leads')) return [{ id: 'lead-row' }];
      return [];
    });
    await handlePageWebhookJob({ object: 'page', entry: [
      { id: '111', changes: [leadgen({ leadgen_id: '999', page_id: '111' })] },
      { id: '222', changes: [leadgen({ leadgen_id: '888', page_id: '222' })] },
    ] });
    expect(h.tenants).toEqual([{ accountId: ACCOUNT, role: 'owner' }]);
    const job = h.executeRaw.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO jobs'));
    expect(job?.[1]).toEqual(['meta.leadgen_fetch', ACCOUNT, JSON.stringify({ accountId: ACCOUNT, leadgenId: '999' }), `meta-lead:${ACCOUNT}:999`]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('"count":1');
    expect(logged).not.toMatch(/888|222|999/);
    warn.mockRestore();
  });

  it('does not queue a second fetch for a duplicate delivery', async () => {
    enable();
    h.queryRaw.mockImplementation(async (sql: string) =>
      sql.includes('crm_resolve_page_account') ? [{ account_id: ACCOUNT, connection_id: CONNECTION }] : []);
    await handlePageWebhookJob(webhook([leadgen({ leadgen_id: '999', page_id: '111' })]));
    expect(h.executeRaw).not.toHaveBeenCalled();
  });
});

describe('handleLeadgenFetchJob', () => {
  const pending = () => h.queryRaw.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM meta_leads')) return [{ status: 'pending', connection_id: CONNECTION, page_id: '111' }];
    if (sql.includes('FROM contacts')) return [];
    if (sql.includes('INSERT INTO contacts')) return [{ id: 'contact-1' }];
    return [];
  });

  it('stores the answers and the created contact, never opting it in', async () => {
    enable();
    pending();
    h.connection.mockResolvedValue(connection());
    h.getLead.mockResolvedValue(lead);
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' });
    expect(h.getLead).toHaveBeenCalledWith('999', 'PAGE-TOKEN');
    const contactInsert = h.queryRaw.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO contacts'));
    expect(contactInsert?.[0]).not.toMatch(/opt/i);
    const store = h.executeRaw.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO meta_leads'));
    expect(store?.[1]).toEqual(expect.arrayContaining(['contact-1', JSON.stringify(lead.fieldData)]));
  });

  it('skips without a network call when the lead is gone or leads scopes are missing', async () => {
    enable();
    h.connection.mockResolvedValue(connection());
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' });
    pending();
    h.connection.mockResolvedValue(connection({ scopes: ['ads_read'] }));
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' });
    expect(h.getLead).not.toHaveBeenCalled();
  });

  it('retries throttles and outages, records a rejection, and flags an invalid token', async () => {
    enable();
    pending();
    h.connection.mockResolvedValue(connection());
    h.getLead.mockRejectedValueOnce(new MetaApiError('Meta API error: 429', { httpStatus: 429, code: 4 }));
    await expect(handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' })).rejects.toThrow(MetaApiError);
    h.getLead.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' })).rejects.toThrow('fetch failed');
    expect(h.executeRaw).not.toHaveBeenCalled();

    h.getLead.mockRejectedValueOnce(new MetaApiError('Meta API error: 400', { httpStatus: 400, code: 100, subcode: 33 }));
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' });
    expect(h.executeRaw.mock.calls.at(-1)?.[1]).toEqual(['100:33', ACCOUNT, '999']);

    h.getLead.mockRejectedValueOnce(new MetaApiError('Meta API error: 401', { httpStatus: 401, code: 190 }));
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' });
    expect(h.executeRaw.mock.calls.some(([sql]) => (sql as string).includes("status='token_invalid'"))).toBe(true);
  });

  it('rejects a malformed job payload', async () => {
    enable();
    await expect(handleLeadgenFetchJob(ACCOUNT, { leadgenId: "1' OR 1=1" })).rejects.toThrow('Invalid job identifier');
  });
});

describe('handleLeadsSyncJob', () => {
  it('upserts forms and leads, then advances the sync time', async () => {
    enable();
    h.connection.mockResolvedValue(connection());
    h.queryRaw.mockResolvedValue([]);
    h.listLeadForms.mockResolvedValue([{ id: '555', name: 'Form', status: 'ACTIVE', questions: [] }]);
    h.listFormLeads.mockResolvedValueOnce({ leads: [lead], nextCursor: 'c2' }).mockResolvedValueOnce({ leads: [], nextCursor: null });
    await handleLeadsSyncJob(ACCOUNT, {});
    expect(h.listFormLeads).toHaveBeenCalledTimes(2);
    expect(h.listFormLeads.mock.calls[1][2]).toMatchObject({ after: 'c2' });
    const sqls = h.executeRaw.mock.calls.map(([sql]) => sql as string);
    expect(sqls.some((s) => s.includes('INSERT INTO meta_lead_forms'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO meta_leads'))).toBe(true);
    expect(sqls.at(-1)).toContain('SET leads_synced_at=');
  });

  it('keeps the cursor when Meta rejects the call', async () => {
    enable();
    h.connection.mockResolvedValue(connection());
    h.listLeadForms.mockRejectedValue(new MetaApiError('Meta API error: 403', { httpStatus: 403, code: 200 }));
    await handleLeadsSyncJob(ACCOUNT, {});
    const sqls = h.executeRaw.mock.calls.map(([sql]) => sql as string);
    expect(sqls.some((s) => s.includes('leads_synced_at='))).toBe(false);
    expect(sqls.some((s) => s.includes('last_error_code='))).toBe(true);
  });
});

describe('review fixes', () => {
  const sqls = () => [...h.queryRaw.mock.calls, ...h.executeRaw.mock.calls].map(([sql]) => sql as string);

  it('R13: rejects calendar days that do not exist instead of rolling them over', () => {
    for (const day of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-00-10'])
      expect(() => parseLeadsFilter(new URLSearchParams(`from=${day}`))).toThrow(LeadsInputError);
    expect(parseLeadsFilter(new URLSearchParams('to=2028-02-29')).to).toBe('2028-02-29');
  });

  it('R0: masks phone answers that carry extra text, and numbers inside other answers', async () => {
    h.queryRaw.mockImplementation(async (sql: string) => {
      if (sql.includes('account_memberships')) return [{ role: 'agent', mask_phone_numbers: true }];
      if (sql.includes('FROM meta_leads')) return [{
        id: '6f1c2d3e-0000-4000-8000-000000000001', leadgen_id: '999', form_id: null, form_name: null, ad_id: null, ad_name: null,
        campaign_name: null, status: 'fetched', contact_id: null, contact_name: 'Asha 9876543210', lead_created_at: null,
        received_at: new Date('2026-11-03T10:00:00Z'), received_key: '2026-11-03T10:00:00.123456Z',
        field_data: [
          { name: 'phone_number', values: ['9876543210 (WhatsApp)'] },
          { name: 'whatsapp_number', values: ['p:+919876543210'] },
          { name: 'alternate_contact', values: ['Alternate: +91 98765 43210'] },
          { name: 'city', values: ['Pune'] },
        ],
      }];
      return [];
    });
    const { leads } = await listLeads({ accountId: ACCOUNT, userId: '6f1c2d3e-0000-4000-8000-0000000000cc', role: 'agent' }, {});
    const text = JSON.stringify(leads);
    expect(text).not.toMatch(/98765\s?43210|9876543210/);
    expect(leads[0].answers.find((a) => a.name === 'city')?.values).toEqual(['Pune']);
    expect(leads[0].answers.find((a) => a.name === 'alternate_contact')?.values[0]).toMatch(/^Alternate: /);
    expect(leads[0].contactName).toMatch(/^Asha /);
  });

  it('R9: the cursor keeps microsecond precision and is compared as timestamptz', async () => {
    const row = (i: number) => ({
      id: `6f1c2d3e-0000-4000-8000-${String(i).padStart(12, '0')}`, leadgen_id: String(i), form_id: null, form_name: null, ad_id: null,
      ad_name: null, campaign_name: null, status: 'fetched', field_data: [], contact_id: null, contact_name: null, lead_created_at: null,
      received_at: new Date('2026-11-03T10:00:00.123Z'), received_key: '2026-11-03T10:00:00.123456Z',
    });
    h.queryRaw.mockImplementation(async (sql: string) => (sql.includes('FROM meta_leads') ? Array.from({ length: 51 }, (_, i) => row(51 - i)) : []));
    const ctx = { accountId: ACCOUNT, userId: '6f1c2d3e-0000-4000-8000-0000000000cc', role: 'admin' as const };
    const first = await listLeads(ctx, {});
    expect(first.leads).toHaveLength(50);
    expect(Buffer.from(first.nextCursor!, 'base64url').toString()).toBe(`2026-11-03T10:00:00.123456Z|${row(2).id}`);
    const filter = parseLeadsFilter(new URLSearchParams({ cursor: first.nextCursor! }));
    h.queryRaw.mockClear();
    await listLeads(ctx, filter);
    const [sql, values] = h.queryRaw.mock.calls.find(([q]) => (q as string).includes('FROM meta_leads'))!;
    expect(sql).toContain('(l.received_at, l.id) < (?::timestamptz, ?::uuid)');
    expect(sql).toContain("l.status<>'erased'");
    expect(values).toContain('2026-11-03T10:00:00.123456Z');
    // A millisecond cursor (the old shape) is refused rather than silently skipping rows.
    const old = Buffer.from(`2026-11-03T10:00:00.123Z|${row(2).id}`).toString('base64url');
    expect(() => parseLeadsFilter(new URLSearchParams({ cursor: old }))).toThrow(LeadsInputError);
  });

  it('R10/R11: an erased or already-fetched lead is left alone before any contact is matched or created', async () => {
    for (const status of ['erased', 'fetched']) {
      vi.clearAllMocks();
      h.executeRaw.mockResolvedValue(1);
      h.queryRaw.mockImplementation(async (sql: string) => (sql.includes('FROM meta_leads') ? [{ status }] : []));
      await storeFetchedLeadTx(client as never, ACCOUNT, CONNECTION, '111', lead);
      expect(sqls().some((q) => q.includes('contacts'))).toBe(false);
      expect(h.executeRaw).not.toHaveBeenCalled();
      expect(h.queryRaw.mock.calls[0][0]).toContain('FOR UPDATE');
    }
    // A new lead still stores, and the upsert never overwrites a tombstone.
    vi.clearAllMocks();
    h.executeRaw.mockResolvedValue(1);
    h.queryRaw.mockImplementation(async (sql: string) => (sql.includes('INSERT INTO contacts') ? [{ id: 'c1' }] : []));
    await storeFetchedLeadTx(client as never, ACCOUNT, CONNECTION, '111', lead);
    expect(h.executeRaw.mock.calls[0][0]).toContain("status NOT IN ('fetched','erased')");
  });

  it('R10: the fetch job skips an erased lead without a network call', async () => {
    enable();
    h.connection.mockResolvedValue(connection());
    h.queryRaw.mockImplementation(async (sql: string) =>
      (sql.includes('FROM meta_leads') ? [{ status: 'erased', connection_id: CONNECTION, page_id: '111' }] : []));
    await handleLeadgenFetchJob(ACCOUNT, { leadgenId: '999' });
    expect(h.getLead).not.toHaveBeenCalled();
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('R10: erasure keeps a content-free tombstone instead of deleting the row', async () => {
    h.queryRaw.mockResolvedValueOnce([{ id: 'x' }]);
    await expect(deleteLead({ accountId: ACCOUNT, userId: CONNECTION }, '6f1c2d3e-0000-4000-8000-000000000001')).resolves.toBe(true);
    const [sql] = h.queryRaw.mock.calls[0];
    expect(sql).not.toContain('DELETE');
    expect(sql).toMatch(/status='erased', field_data='\[\]'::jsonb, contact_id=NULL/);
    expect(sql).toContain("status<>'erased'");
  });

  describe('R12: backfill bounds', () => {
    const forms = (n: number, status = 'ACTIVE') => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), name: null, status, questions: [] }));
    const jobInsert = () => h.executeRaw.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO jobs'));

    it('queues a continuation at the form and cursor where the page cap stopped, and still moves the window', async () => {
      enable();
      h.connection.mockResolvedValue(connection());
      h.listLeadForms.mockResolvedValue([...forms(1, 'ARCHIVED'), ...forms(2)].map((f, i) => ({ ...f, id: String(2000 + i) })));
      h.listFormLeads.mockResolvedValue({ leads: [], nextCursor: 'QVFI-cur_sor=' });
      await handleLeadsSyncJob(ACCOUNT, {});
      expect(h.listFormLeads).toHaveBeenCalledTimes(5);
      expect(h.listFormLeads.mock.calls.every(([formId]) => formId === '2001')).toBe(true); // the archived form is skipped
      const [, values] = jobInsert()!;
      const body = JSON.parse(values[2] as string);
      expect(body).toMatchObject({ connectionId: CONNECTION, formId: '2001', after: 'QVFI-cur_sor=' });
      expect(values[0]).toBe('meta.leads_sync');
      expect(values[3]).toMatch(new RegExp(`^meta-leads-more:${ACCOUNT}:[0-9a-f]{40}$`));
      expect(h.executeRaw.mock.calls.at(-1)?.[0]).toContain('SET leads_synced_at=');
    });

    it('queues the first form past the form cap', async () => {
      enable();
      h.connection.mockResolvedValue(connection());
      h.listLeadForms.mockResolvedValue(forms(52));
      h.listFormLeads.mockResolvedValue({ leads: [], nextCursor: null });
      await handleLeadsSyncJob(ACCOUNT, {});
      expect(h.listFormLeads).toHaveBeenCalledTimes(50);
      expect(JSON.parse(jobInsert()![1][2] as string)).toMatchObject({ formId: '1050', after: null });
    });

    it('a continuation resumes at its form and cursor, keeps since, and does not move the window', async () => {
      enable();
      h.connection.mockResolvedValue(connection());
      h.listLeadForms.mockResolvedValue(forms(3));
      h.listFormLeads.mockResolvedValue({ leads: [], nextCursor: null });
      await handleLeadsSyncJob(ACCOUNT, { connectionId: CONNECTION, since: 1762000000, formId: '1001', after: 'abc' });
      expect(h.listFormLeads.mock.calls.map(([id, , o]) => [id, o])).toEqual([
        ['1001', { since: 1762000000, after: 'abc' }], ['1002', { since: 1762000000, after: undefined }],
      ]);
      expect(sqls().some((q) => q.includes('leads_synced_at=') || q.includes('INSERT INTO jobs') || q.includes('meta_lead_forms'))).toBe(false);
    });

    it('a continuation for another connection or a closed form does nothing; a bad payload is rejected', async () => {
      enable();
      h.connection.mockResolvedValue(connection());
      h.listLeadForms.mockResolvedValue(forms(1, 'ARCHIVED'));
      await handleLeadsSyncJob(ACCOUNT, { connectionId: '6f1c2d3e-0000-4000-8000-0000000000dd', since: 1, formId: '1000', after: null });
      await handleLeadsSyncJob(ACCOUNT, { connectionId: CONNECTION, since: 1, formId: '1000', after: null });
      expect(h.listFormLeads).not.toHaveBeenCalled();
      expect(h.executeRaw).not.toHaveBeenCalled();
      for (const bad of [{ since: 1 }, { connectionId: CONNECTION, since: 1, formId: '1', after: 'a b' }, { connectionId: CONNECTION, since: -1, formId: '1', after: null }])
        expect(() => parseSyncResume(bad)).toThrow('Invalid job payload');
      expect(parseSyncResume({})).toBeNull();
    });
  });
});
