import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake tenant transactions: each raw query is answered by `h.answer` from its SQL text.
const h = vi.hoisted(() => ({
  enabled: true,
  queries: [] as { sql: string; values: unknown[] }[],
  answer: (sql: string): unknown => { void sql; return []; },
  tenants: [] as unknown[],
  room: vi.fn(async () => {}),
}));

vi.mock('./config', async (original) => ({
  ...(await original<typeof import('./config')>()),
  metaAdsConfig: () => (h.enabled ? { appId: '1', appSecret: 's', loginConfigId: '2', pageWebhookVerifyToken: null } : null),
}));
const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?');
  h.queries.push({ sql, values });
  return Promise.resolve(h.answer(sql));
};
const tx = { $queryRaw: run, $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => run(s, ...v).then(() => 1) };
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, op: (t: typeof tx) => unknown, db?: unknown) => {
    h.tenants.push({ ctx, worker: (db as { worker?: boolean } | undefined)?.worker === true });
    return op(tx);
  },
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ ...tx, worker: true }) }));
vi.mock('@/lib/billing/limits', () => ({ requireIntegrationRoom: h.room }));
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('./graph', async (original) => ({
  ...(await original<typeof import('./graph')>()),
  exchangeLoginCode: vi.fn(async () => ({ accessToken: 'user-token' })),
  getGrantedScopes: vi.fn(async () => ['ads_read', 'leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads']),
  listAdAccounts: vi.fn(async () => [{ id: '111', name: 'Acct', currency: 'INR', businessId: '999' }]),
  listPages: vi.fn(async () => [{ id: '222', name: 'Page', accessToken: 'page-token' }]),
  subscribePageLeadgen: vi.fn(async () => {}),
  unsubscribePage: vi.fn(async () => {}),
  getOrCreateDataset: vi.fn(async () => '333'),
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import * as graph from './graph';
import {
  disconnect, finishConnection, listChoices, MetaAdsError, startConnection, toDto, updateCapiSettings,
  type MetaAdConnectionRow, type MetaAdsActor,
} from './connection';

const admin: MetaAdsActor = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const agent: MetaAdsActor = { ...admin, role: 'agent' };
const row = (over: Partial<MetaAdConnectionRow> = {}): MetaAdConnectionRow => ({
  id: 'c1', status: 'active', business_id: null, ad_account_id: '111', ad_account_name: 'Acct', ad_account_currency: 'INR',
  page_id: '222', page_name: 'Page', token_expires_at: null, scopes: [], page_subscribed_at: null, capi_enabled: false,
  capi_dataset_id: null, capi_whatsapp_config_id: null, capi_waba_id: null, capi_auto_purchase: true, capi_auto_lead: false,
  insights_synced_at: null, leads_synced_at: null, last_error_code: null, connected_at: null, disconnected_at: null, ...over,
});
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof MetaAdsError ? error.code : error;
  }
  return 'resolved';
};
const ran = (pattern: RegExp) => h.queries.some((q) => pattern.test(q.sql));

beforeEach(() => {
  h.enabled = true;
  h.queries = [];
  h.tenants = [];
  h.answer = () => [];
  vi.clearAllMocks();
});

describe('gating', () => {
  it('refuses every action while disabled, before any SQL or Graph call', async () => {
    h.enabled = false;
    for (const call of [
      startConnection(admin, 'code'), listChoices(admin), finishConnection(admin, { adAccountId: '1', pageId: '2' }),
      updateCapiSettings(admin, { capiEnabled: false }),
    ]) expect(await code(call)).toBe('meta_ads_not_enabled');
    expect(h.queries).toEqual([]);
    expect(graph.exchangeLoginCode).not.toHaveBeenCalled();
  });

  it('refuses members below admin', async () => {
    expect(await code(startConnection(agent, 'code'))).toBe('forbidden');
    expect(await code(disconnect(agent))).toBe('forbidden');
    expect(h.queries).toEqual([]);
  });
});

describe('startConnection', () => {
  it('stores the encrypted user token on the pending row through the worker', async () => {
    h.answer = (sql) => (/INSERT INTO meta_ad_connections/.test(sql) ? [row({ status: 'pending', ad_account_id: null })] : []);
    const dto = await startConnection(admin, ' the-code ');
    expect(graph.exchangeLoginCode).toHaveBeenCalledWith(expect.anything(), 'the-code');
    const insert = h.queries.find((q) => /INSERT INTO meta_ad_connections/.test(q.sql))!;
    expect(insert.sql).toMatch(/ON CONFLICT \(account_id\) WHERE status <> 'disconnected' DO UPDATE/);
    expect(insert.sql).toMatch(/WHERE meta_ad_connections\.status='pending'/);
    expect(insert.values).toContain('enc:user-token');
    expect(insert.values).not.toContain('user-token');
    expect(h.tenants.every((t) => (t as { worker: boolean }).worker)).toBe(true);
    expect(dto.status).toBe('pending');
    expect(JSON.stringify(dto)).not.toMatch(/user-token|enc:/);
  });

  it('refuses while an active connection exists, without exchanging the code', async () => {
    h.answer = (sql) => (/SELECT/.test(sql) && /status<>'disconnected'/.test(sql) ? [row()] : []);
    expect(await code(startConnection(admin, 'code'))).toBe('already_connected');
    expect(graph.exchangeLoginCode).not.toHaveBeenCalled();
  });

  it('gates from the row re-read in the insert transaction, not the one read before the Meta calls', async () => {
    // Pending at first read, disconnected by the time of the insert: the new row takes a slot.
    let reads = 0;
    h.answer = (sql) => {
      if (/INSERT INTO meta_ad_connections/.test(sql)) return [row({ status: 'pending', ad_account_id: null })];
      if (/SELECT/.test(sql) && /status<>'disconnected'/.test(sql)) return reads++ === 0 ? [row({ status: 'pending' })] : [];
      return [];
    };
    await startConnection(admin, 'code');
    expect(h.room).toHaveBeenCalledTimes(1);
    // Nothing live at first read, a pending row by the insert: refreshing it takes no slot.
    h.room.mockClear(); reads = 0;
    h.answer = (sql) => {
      if (/INSERT INTO meta_ad_connections/.test(sql)) return [row({ status: 'pending', ad_account_id: null })];
      if (/SELECT/.test(sql) && /status<>'disconnected'/.test(sql)) return reads++ === 0 ? [] : [row({ status: 'pending' })];
      return [];
    };
    await startConnection(admin, 'code');
    expect(h.room).not.toHaveBeenCalled();
    // Active by the insert: refused, nothing written.
    reads = 0; h.queries = [];
    h.answer = (sql) => (/SELECT/.test(sql) && /status<>'disconnected'/.test(sql) ? (reads++ === 0 ? [] : [row()]) : []);
    expect(await code(startConnection(admin, 'code'))).toBe('already_connected');
    expect(ran(/INSERT INTO meta_ad_connections/)).toBe(false);
  });

  it('maps Meta failures to fixed codes', async () => {
    vi.mocked(graph.exchangeLoginCode).mockRejectedValueOnce(new MetaApiError('secret text', { code: 190, httpStatus: 400 }));
    expect(await code(startConnection(admin, 'code'))).toBe('token_invalid');
    vi.mocked(graph.exchangeLoginCode).mockRejectedValueOnce(new MetaApiError('x', { code: 100, httpStatus: 400 }));
    expect(await code(startConnection(admin, 'code'))).toBe('meta_error');
    expect(await code(startConnection(admin, 'x'.repeat(1025)))).toBe('invalid_request');
  });
});

describe('finishConnection', () => {
  const pending = (sql: string) =>
    /status='pending' LIMIT 1/.test(sql) ? [{ id: 'c1', user_token_enc: 'enc:user-token', scopes: ['leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads'] }] : null;

  it('rejects a choice the token cannot see', async () => {
    h.answer = (sql) => pending(sql) ?? [];
    expect(await code(finishConnection(admin, { adAccountId: '111', pageId: '999' }))).toBe('invalid_choice');
    expect(await code(finishConnection(admin, { adAccountId: 'act_1', pageId: '222' }))).toBe('invalid_choice');
    expect(ran(/UPDATE meta_ad_connections/)).toBe(false);
  });

  it('refuses a Page held by another workspace', async () => {
    h.answer = (sql) => pending(sql) ?? (/crm_page_owner_account/.test(sql) ? [{ owner: '99999999-9999-4999-8999-999999999999' }] : []);
    expect(await code(finishConnection(admin, { adAccountId: '111', pageId: '222' }))).toBe('page_in_use');
    expect(ran(/UPDATE meta_ad_connections/)).toBe(false);
  });

  it('maps the unique-index race to page_in_use', async () => {
    h.answer = (sql) => {
      if (/UPDATE meta_ad_connections SET\s+status='active'/.test(sql)) throw Object.assign(new Error('dup'), { code: '23505' });
      return pending(sql) ?? [];
    };
    expect(await code(finishConnection(admin, { adAccountId: '111', pageId: '222' }))).toBe('page_in_use');
  });

  it('activates, audits, then subscribes the Page to leadgen', async () => {
    h.answer = (sql) => pending(sql) ?? (/UPDATE meta_ad_connections/.test(sql) ? [row()] : []);
    const dto = await finishConnection(admin, { adAccountId: '111', pageId: '222' });
    expect(dto.status).toBe('active');
    const activate = h.queries.find((q) => /status='active', business_id/.test(q.sql))!;
    expect(activate.values).toContain('enc:page-token');
    expect(ran(/INSERT INTO audit_logs/)).toBe(true);
    expect(graph.subscribePageLeadgen).toHaveBeenCalledWith('222', 'page-token');
    expect(ran(/page_subscribed_at=CASE/)).toBe(true);
  });
});

describe('disconnect', () => {
  it('keeps the connection when Meta cannot unsubscribe the Page', async () => {
    h.answer = (sql) => (/SELECT id::text AS id, status, page_id/.test(sql)
      ? [{ id: 'c1', status: 'active', page_id: '222', page_token_enc: 'enc:page-token', page_subscribed_at: new Date() }] : []);
    vi.mocked(graph.unsubscribePage).mockRejectedValueOnce(new MetaApiError('x', { httpStatus: 500 }));
    expect(await code(disconnect(admin))).toBe('revoke_failed');
    expect(ran(/status='disconnected'/)).toBe(false);
  });

  it('disconnects a token_invalid connection without calling Meta and clears both tokens', async () => {
    h.answer = (sql) => {
      if (/SELECT id::text AS id, status, page_id/.test(sql))
        return [{ id: 'c1', status: 'token_invalid', page_id: '222', page_token_enc: 'enc:t', page_subscribed_at: new Date() }];
      if (/status='disconnected'/.test(sql)) return [row({ status: 'disconnected' })];
      return [];
    };
    const dto = await disconnect(admin);
    expect(graph.unsubscribePage).not.toHaveBeenCalled();
    expect(h.queries.find((q) => /status='disconnected'/.test(q.sql))!.sql).toMatch(/user_token_enc='', page_token_enc=''/);
    expect(ran(/INSERT INTO audit_logs/)).toBe(true);
    expect(dto?.status).toBe('disconnected');
  });

  it('returns null when nothing is connected', async () => {
    expect(await disconnect(admin)).toBeNull();
  });

  it('still clears the tokens of a subscribed connection while disabled, skipping the Meta call', async () => {
    h.enabled = false;
    h.answer = (sql) => {
      if (/SELECT id::text AS id, status, page_id/.test(sql))
        return [{ id: 'c1', status: 'active', page_id: '222', page_token_enc: 'enc:t', page_subscribed_at: new Date() }];
      if (/status='disconnected'/.test(sql)) return [row({ status: 'disconnected' })];
      return [];
    };
    const dto = await disconnect(admin);
    expect(graph.unsubscribePage).not.toHaveBeenCalled();
    expect(h.queries.find((q) => /status='disconnected'/.test(q.sql))!.sql).toMatch(/user_token_enc='', page_token_enc=''/);
    const auditQ = h.queries.find((q) => /INSERT INTO audit_logs/.test(q.sql))!;
    expect(JSON.stringify(auditQ.values)).toContain('unsubscribeSkipped');
    expect(dto?.status).toBe('disconnected');
  });

  it('records no unsubscribeSkipped when Meta was called', async () => {
    h.answer = (sql) => {
      if (/SELECT id::text AS id, status, page_id/.test(sql))
        return [{ id: 'c1', status: 'active', page_id: '222', page_token_enc: 'enc:t', page_subscribed_at: new Date() }];
      if (/status='disconnected'/.test(sql)) return [row({ status: 'disconnected' })];
      return [];
    };
    await disconnect(admin);
    expect(graph.unsubscribePage).toHaveBeenCalledWith('222', 't');
    expect(JSON.stringify(h.queries.find((q) => /INSERT INTO audit_logs/.test(q.sql))!.values)).not.toContain('unsubscribeSkipped');
  });
});

describe('updateCapiSettings', () => {
  const live = (over: Record<string, unknown> = {}) => (sql: string) => {
    if (/FROM meta_ad_connections WHERE/.test(sql) && /user_token_enc\s+FROM/.test(sql))
      return [{ id: 'c1', status: 'active', scopes: ['whatsapp_business_manage_events'], capi_enabled: false,
        capi_whatsapp_config_id: null, capi_dataset_id: null, capi_waba_id: null, user_token_enc: 'enc:user-token', ...over }];
    if (/FROM whatsapp_config/.test(sql)) return [{ waba_id: '444' }];
    if (/UPDATE meta_ad_connections/.test(sql)) return [row({ capi_enabled: true, capi_dataset_id: '333' })];
    return [];
  };

  it('creates the dataset for the number WABA when enabling', async () => {
    h.answer = live();
    const dto = await updateCapiSettings(admin, { capiEnabled: true, capiWhatsappConfigId: '33333333-3333-4333-8333-333333333333' });
    expect(graph.getOrCreateDataset).toHaveBeenCalledWith('444', 'user-token');
    expect(h.queries.find((q) => /UPDATE meta_ad_connections/.test(q.sql))!.values).toEqual(expect.arrayContaining(['333', '444']));
    expect(dto.capiEnabled).toBe(true);
  });

  it('needs a number and the CAPI permission to enable', async () => {
    h.answer = live();
    expect(await code(updateCapiSettings(admin, { capiEnabled: true }))).toBe('invalid_number');
    h.answer = live({ scopes: [] });
    expect(await code(updateCapiSettings(admin, { capiEnabled: true, capiWhatsappConfigId: '33333333-3333-4333-8333-333333333333' }))).toBe('missing_scope');
    expect(graph.getOrCreateDataset).not.toHaveBeenCalled();
  });
});

it('builds the DTO from an explicit list with no token field', () => {
  const dto = toDto({ ...row(), user_token_enc: 'x', page_token_enc: 'y' } as MetaAdConnectionRow);
  expect(Object.keys(dto).some((k) => /token_enc|TokenEnc|clid/i.test(k))).toBe(false);
});
