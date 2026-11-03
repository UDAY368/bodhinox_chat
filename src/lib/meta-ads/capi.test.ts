import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const REFERRAL = '44444444-4444-4444-8444-444444444444';

type Responder = (sql: string, values: unknown[]) => unknown;
const h = vi.hoisted(() => ({
  respond: (() => []) as (sql: string, values: unknown[]) => unknown,
  executed: [] as string[],
  queried: [] as string[],
  dispatch: vi.fn(),
  connection: null as unknown,
}));

const fakeTx = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    h.queried.push(sql);
    return h.respond(sql, values);
  }),
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
    h.executed.push(strings.join('?'));
    return 1;
  }),
};

vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, work: (tx: unknown) => unknown) => work(fakeTx) }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/jobs/dispatch', async (orig) => ({
  ...(await orig<typeof import('@/lib/jobs/dispatch')>()),
  dispatchOnce: h.dispatch,
}));
vi.mock('./connection', () => ({ loadActiveConnectionTx: async () => h.connection }));
vi.mock('./graph', async (orig) => ({ ...(await orig<typeof import('./graph')>()), postCapiEvents: vi.fn(async () => ({ eventsReceived: 1 })) }));

import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import {
  CAPI_THROTTLE_DELAYS_MS, capiValue, cleanValue, conversionEventId, handleCapiEventJob, parseListFilter, parseResolution, queueConversionEvent, queueConversionEventTx,
} from './capi';

const ENV = { META_ADS_ENABLED: 'true', META_APP_ID: '123', META_APP_SECRET_PRIMARY: 'test-only', META_ADS_LOGIN_CONFIG_ID: '456' };
const saved = { ...process.env };
const input = { accountId: ACCOUNT, eventName: 'Purchase' as const, source: 'payment_link' as const, sourceId: 'link-1', contactId: CONTACT };
const active = {
  id: 'c1', userToken: 'test-only-token', scopes: ['whatsapp_business_manage_events'], capiEnabled: true,
  capiDatasetId: '777', capiWabaId: '888', capiWhatsappConfigId: null,
};
const queued = { id: EVENT, event_id: 'flow:r:n:Purchase', event_name: 'Purchase', status: 'queued', ad_referral_id: REFERRAL, value: 10, currency: 'INR', event_time: new Date() };

function stateResponder(over: Partial<Record<'event' | 'intent' | 'referral', unknown[]>> = {}): Responder {
  return (sql) => {
    if (sql.includes('FROM capi_events')) return over.event ?? [queued];
    if (sql.includes('FROM outbound_intents')) return over.intent ?? [];
    if (sql.includes('FROM ad_referrals')) return over.referral ?? [{ ctwa_clid: 'clid', waba_id: '888' }];
    return [];
  };
}
const statusUpdates = () => h.executed.filter((s) => s.includes('UPDATE capi_events SET status'));

beforeEach(() => {
  Object.assign(process.env, ENV);
  h.executed = [];
  h.queried = [];
  h.respond = () => [];
  h.connection = active;
  h.dispatch.mockReset();
  fakeTx.$queryRaw.mockClear();
  fakeTx.$executeRaw.mockClear();
});
afterEach(() => {
  process.env = { ...saved };
});

describe('conversionEventId', () => {
  it('keys a Purchase by the order, whichever path reports it', () => {
    const order = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fromLink = conversionEventId({ eventName: 'Purchase', source: 'payment_link', sourceId: 'link-1', orderId: order });
    const fromOrder = conversionEventId({ eventName: 'Purchase', source: 'order', sourceId: order, orderId: order });
    expect(fromLink).toBe(`order:${order}:Purchase`);
    expect(fromOrder).toBe(fromLink);
  });
  it('is deterministic per source otherwise', () => {
    expect(conversionEventId({ eventName: 'Purchase', source: 'payment_link', sourceId: 'l1' })).toBe('payment_link:l1:Purchase');
    expect(conversionEventId({ eventName: 'LeadSubmitted', source: 'form', sourceId: 'wamid.1' })).toBe('form:wamid.1:LeadSubmitted');
    expect(conversionEventId({ eventName: 'QualifiedLead', source: 'flow', sourceId: 'run:node' })).toBe('flow:run:node:QualifiedLead');
  });
});

describe('capiValue', () => {
  it('converts minor units with the currency exponent', () => {
    expect(capiValue(49_900, 'INR')).toBe(499);
    expect(capiValue(BigInt(1250), 'INR')).toBe(12.5);
    expect(capiValue(500, 'JPY')).toBe(500);
  });
  it('keeps three-decimal currencies exact', () => {
    expect(capiValue(12_345, 'KWD')).toBe(12.345);
    expect(cleanValue(capiValue(12_345, 'KWD'), 'KWD')).toBe(12.345);
    expect(cleanValue(12.3456, 'KWD')).toBe(12.346);
    expect(cleanValue(12.345, 'INR')).toBe(12.35);
    expect(cleanValue(499.6, 'JPY')).toBe(500);
    expect(cleanValue(-1, 'INR')).toBeNull();
  });
  it('omits what cannot be represented', () => {
    expect(capiValue(null, 'INR')).toBeNull();
    expect(capiValue(100, 'inr')).toBeNull();
    expect(capiValue(Number.MAX_SAFE_INTEGER, 'INR')).toBeNull();
  });
});

describe('queueConversionEventTx', () => {
  it('runs no SQL while the feature is off', async () => {
    process.env.META_ADS_ENABLED = 'false';
    expect(await queueConversionEventTx(fakeTx as never, input)).toBe(false);
    expect(await queueConversionEvent(ACCOUNT, input)).toBe(false);
    expect(fakeTx.$queryRaw).not.toHaveBeenCalled();
    expect(fakeTx.$executeRaw).not.toHaveBeenCalled();
  });

  it('runs no SQL without a contact', async () => {
    expect(await queueConversionEventTx(fakeTx as never, { ...input, contactId: null })).toBe(false);
    expect(fakeTx.$queryRaw).not.toHaveBeenCalled();
  });

  it('queues no row without an attributable click', async () => {
    h.respond = (sql) => sql.includes('FROM meta_ad_connections')
      ? [{ id: 'c1', capi_enabled: true, capi_dataset_id: '777', capi_waba_id: '888', capi_whatsapp_config_id: null, capi_auto_purchase: true, capi_auto_lead: false }]
      : [];
    expect(await queueConversionEventTx(fakeTx as never, input)).toBe(false);
    expect(h.queried.some((s) => s.includes('INSERT INTO capi_events'))).toBe(false);
    expect(h.executed.some((s) => s.includes('INSERT INTO jobs'))).toBe(false);
  });

  it('respects the auto-purchase toggle', async () => {
    h.respond = (sql) => sql.includes('FROM meta_ad_connections')
      ? [{ id: 'c1', capi_enabled: true, capi_dataset_id: '777', capi_waba_id: '888', capi_whatsapp_config_id: null, capi_auto_purchase: false, capi_auto_lead: false }]
      : [];
    expect(await queueConversionEventTx(fakeTx as never, input)).toBe(false);
    expect(h.queried.some((s) => s.includes('FROM ad_referrals'))).toBe(false);
  });

  it('inserts the row and its job with the deterministic id', async () => {
    h.respond = (sql) => {
      if (sql.includes('FROM meta_ad_connections'))
        return [{ id: 'c1', capi_enabled: true, capi_dataset_id: '777', capi_waba_id: '888', capi_whatsapp_config_id: null, capi_auto_purchase: true, capi_auto_lead: false }];
      if (sql.includes('FROM whatsapp_config')) return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
      if (sql.includes('FROM ad_referrals')) return [{ id: REFERRAL, whatsapp_config_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
      if (sql.includes('INSERT INTO capi_events')) return [{ id: EVENT }];
      return [];
    };
    expect(await queueConversionEventTx(fakeTx as never, { ...input, value: 499.999, currency: 'INR' })).toBe(true);
    const insert = fakeTx.$queryRaw.mock.calls.find((c) => c[0].join('?').includes('INSERT INTO capi_events'))!;
    expect(insert).toContain('payment_link:link-1:Purchase');
    expect(insert).toContain(500);
    const job = fakeTx.$executeRaw.mock.calls.find((c) => c[0].join('?').includes('INSERT INTO jobs'))!;
    expect(job).toContain(`capi:${ACCOUNT}:payment_link:link-1:Purchase`);
    expect(job).toContain(JSON.stringify({ capiEventId: EVENT }));
  });

  it('never throws: an SQL error rolls back to its savepoint', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.respond = () => { throw new Error('boom with customer data'); };
    expect(await queueConversionEventTx(fakeTx as never, input)).toBe(false);
    expect(h.executed).toContain('ROLLBACK TO SAVEPOINT capi_enqueue');
    expect(JSON.stringify(error.mock.calls)).not.toContain('customer');
    error.mockRestore();
  });
});

describe('handleCapiEventJob', () => {
  it('rejects a malformed payload', async () => {
    await expect(handleCapiEventJob(ACCOUNT, { capiEventId: 'x' })).rejects.toThrow('Invalid');
  });

  it('marks the event sent after an accepted dispatch', async () => {
    h.respond = stateResponder();
    h.dispatch.mockImplementation(async (_a: string, key: string, send: () => Promise<unknown>) => {
      expect(key).toBe('capi:flow:r:n:Purchase');
      return send();
    });
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0][3]).toEqual({ retryRejected: true });
    expect(statusUpdates()).toHaveLength(1);
    expect(fakeTx.$executeRaw.mock.calls.at(-1)).toContain('sent');
  });

  it('records a 4xx as failed and finishes without rethrowing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.respond = stateResponder();
    h.dispatch.mockRejectedValue(new MetaApiError('Meta API error', { httpStatus: 400, code: 100, subcode: 33 }));
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 1, maxAttempts: 5 });
    const last = fakeTx.$executeRaw.mock.calls.at(-1)!;
    expect(last).toContain('failed');
    expect(last).toContain('100:33');
    error.mockRestore();
  });

  it('keeps a throttled event queued and re-schedules it minutes later in a new job', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = stateResponder();
    h.respond = (sql, values) => sql.includes('SET last_error_code') ? [{ throttle_count: 2 }] : base(sql, values);
    h.dispatch.mockRejectedValue(new MetaApiError('Meta API error', { httpStatus: 400, code: 80004 }));
    const before = Date.now();
    // Even on the job's last sending attempt, the throttle does not use up the job's short backoff.
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 5, maxAttempts: 6 });
    expect(statusUpdates()).toEqual([]);
    const update = fakeTx.$queryRaw.mock.calls.find((c) => c[0].join('?').includes('SET last_error_code'))!;
    expect(update[0].join('?')).toContain('throttle_count=throttle_count+1');
    expect(update).toContain('80004');
    expect(update).toContain(CAPI_THROTTLE_DELAYS_MS.length);
    const job = fakeTx.$executeRaw.mock.calls.find((c) => c[0].join('?').includes('INSERT INTO jobs'))!;
    expect(job).toContain('meta.capi_event');
    expect(job).toContain(`capi:${ACCOUNT}:flow:r:n:Purchase:throttle:2`);
    expect(job).toContain(JSON.stringify({ capiEventId: EVENT }));
    const runAt = job.find((v) => v instanceof Date) as Date;
    expect(runAt.getTime()).toBeGreaterThanOrEqual(before + CAPI_THROTTLE_DELAYS_MS[1]);
    error.mockRestore();
  });

  it('fails a throttled event once its re-schedules are used up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.respond = stateResponder(); // the guarded UPDATE matches no row
    h.dispatch.mockRejectedValue(new MetaApiError('Meta API error', { httpStatus: 429, code: 4 }));
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 1, maxAttempts: 6 });
    expect(h.executed.some((s) => s.includes('INSERT INTO jobs'))).toBe(false);
    const last = fakeTx.$executeRaw.mock.calls.at(-1)!;
    expect(last).toContain('failed');
    expect(last).toContain('4');
    error.mockRestore();
  });

  it.each([
    ['code 190', new MetaApiError('Meta API error', { httpStatus: 400, code: 190 }), '190'],
    ['HTTP 401', new MetaApiError('Meta API error', { httpStatus: 401 }), '401'],
  ])('marks the connection token_invalid on an invalid token (%s)', async (_name, rejection, code) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.respond = stateResponder();
    h.dispatch.mockRejectedValue(rejection);
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 1, maxAttempts: 6 });
    const conn = fakeTx.$executeRaw.mock.calls.find((c) => c[0].join('?').includes('UPDATE meta_ad_connections'))!;
    expect(conn[0].join('?')).toContain("status='token_invalid'");
    expect(conn[0].join('?')).toContain("status='active'");
    expect(conn).toContain(code);
    expect(conn).toContain('c1');
    const last = fakeTx.$executeRaw.mock.calls.at(-1)!;
    expect(last).toContain('failed');
    expect(last).toContain(code);
    error.mockRestore();
  });

  it('leaves the connection alone for other rejections', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.respond = stateResponder();
    h.dispatch.mockRejectedValue(new MetaApiError('Meta API error', { httpStatus: 400, code: 100 }));
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 1, maxAttempts: 6 });
    expect(h.executed.some((s) => s.includes('meta_ad_connections'))).toBe(false);
    error.mockRestore();
  });

  it('never sends on the job\'s last attempt, so a lost lease can still be reconciled', async () => {
    h.respond = stateResponder();
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 6, maxAttempts: 6 });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(fakeTx.$executeRaw.mock.calls.at(-1)).toContain('failed');
  });

  it('turns a send claimed by a crashed attempt into unknown on the last attempt', async () => {
    h.respond = stateResponder({ intent: [{ status: 'dispatching' }] });
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT }, { attempts: 6, maxAttempts: 6 });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(fakeTx.$executeRaw.mock.calls.at(-1)).toContain('unknown');
  });

  it('marks an ambiguous outcome unknown without rethrowing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.respond = stateResponder();
    h.dispatch.mockRejectedValue(new UncertainDispatchError());
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT });
    expect(fakeTx.$executeRaw.mock.calls.at(-1)).toContain('unknown');
    error.mockRestore();
  });

  it('lets an existing intent decide, without dispatching again', async () => {
    h.respond = stateResponder({ intent: [{ status: 'unknown' }] });
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(fakeTx.$executeRaw.mock.calls.at(-1)).toContain('unknown');
  });

  it.each([
    ['no connection', () => { h.connection = null; }, 'no_connection'],
    ['CAPI off', () => { h.connection = { ...active, capiEnabled: false }; }, 'disabled'],
    ['missing scope', () => { h.connection = { ...active, scopes: ['ads_read'] }; }, 'missing_scope'],
    ['no dataset', () => { h.connection = { ...active, capiDatasetId: null }; }, 'no_dataset'],
    ['another WABA', () => { h.respond = stateResponder({ referral: [{ ctwa_clid: 'clid', waba_id: '999' }] }); }, 'wrong_waba'],
    ['feature off', () => { process.env.META_ADS_ENABLED = 'false'; }, 'disabled'],
  ])('skips with a reason: %s', async (_name, arrange, reason) => {
    h.respond = stateResponder();
    arrange();
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT });
    expect(h.dispatch).not.toHaveBeenCalled();
    const last = fakeTx.$executeRaw.mock.calls.at(-1)!;
    expect(last).toContain('skipped');
    expect(last).toContain(reason);
  });

  it('does nothing for an event that is no longer queued', async () => {
    h.respond = stateResponder({ event: [{ ...queued, status: 'sent' }] });
    await handleCapiEventJob(ACCOUNT, { capiEventId: EVENT });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.executed).toEqual([]);
  });
});

describe('request parsing', () => {
  it('accepts only the two resolutions', () => {
    expect(parseResolution({ resolution: 'confirmed_sent' })).toBe('confirmed_sent');
    expect(parseResolution({ resolution: 'confirmed_not_sent' })).toBe('confirmed_not_sent');
    for (const bad of [null, [], {}, { resolution: 'resend' }, { resolution: 1 }]) expect(parseResolution(bad)).toBeNull();
  });
  it('accepts known status filters', () => {
    expect(parseListFilter(null)).toBeNull();
    expect(parseListFilter('all')).toBeNull();
    expect(parseListFilter('review')).toBe('review');
    expect(parseListFilter('unknown')).toBe('unknown');
    expect(parseListFilter('drop table')).toBeUndefined();
  });
});
