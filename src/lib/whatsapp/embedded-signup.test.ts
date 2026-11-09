import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string; account_id: string; user_id: string; phone_number_id: string; waba_id: string | null; access_token: string;
  display_name: string | null; quality_rating: string | null; status: string; is_default: boolean;
  registered_at: Date | null; subscribed_apps_at: Date | null; connected_at: Date | null; last_registration_error: string | null;
};
const h = vi.hoisted(() => ({
  rows: [] as Row[],
  owner: null as string | null,
  exchange: vi.fn(),
  verify: vi.fn(),
  list: vi.fn(),
  subscribe: vi.fn(),
  register: vi.fn(),
  failUpdateWith: null as null | ((data: Record<string, unknown>) => boolean),
  numberRoom: vi.fn(async () => {}),
  reupload: vi.fn(async () => 'uploaded'),
}));

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const pick = (r: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k as keyof Row]])) : r;
const matches = (r: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => r[k as keyof Row] === v);
const tx = {
  whatsapp_config: {
    findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const r = h.rows.find((row) => matches(row, where));
      return r ? pick(r, select) : null;
    },
    findFirstOrThrow: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const r = await tx.whatsapp_config.findFirst(args);
      if (!r) throw new Error('not found');
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (h.failUpdateWith?.(data)) throw new Error('db down');
      const hit = h.rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
    create: async ({ data }: { data: Partial<Row> }) => {
      const row: Row = {
        id: `cfg-${h.rows.length + 1}`, is_default: !h.rows.some((r) => r.account_id === data.account_id),
        registered_at: null, subscribed_apps_at: null, connected_at: null, last_registration_error: null,
        display_name: null, quality_rating: null, waba_id: null, status: 'disconnected', ...data,
      } as Row;
      h.rows.push(row);
      return { id: row.id };
    },
  },
};

vi.mock('@/lib/db/tenant', () => ({ withTenant: (_t: unknown, op: (t: typeof tx) => unknown) => op(tx) }));
vi.mock('@/lib/billing/entitlements', async (orig) => {
  const actual = await orig<typeof import('@/lib/billing/entitlements')>();
  return { PlanLimitError: actual.PlanLimitError };
});
vi.mock('@/lib/billing/limits', () => ({ requireWhatsAppNumberRoom: h.numberRoom }));
vi.mock('@/lib/repositories/routing', () => ({ resolveWhatsAppAccount: async () => h.owner }));
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('@/lib/whatsapp/forms/keys', () => ({ reuploadFormsKey: h.reupload }));
vi.mock('@/lib/whatsapp/meta-api', async (orig) => {
  const actual = await orig<typeof import('./meta-api')>();
  return {
    MetaApiError: actual.MetaApiError,
    exchangeEmbeddedSignupCode: h.exchange,
    verifyPhoneNumber: h.verify,
    listWabaPhoneNumbers: h.list,
    subscribeWabaToApp: h.subscribe,
    registerPhoneNumber: h.register,
  };
});

import {
  isEmbeddedSignupOrigin,
  parseEmbeddedSignupMessage,
  parseEmbeddedSignupRequest,
} from './embedded-signup';
import { codeExchangeSecret, connectEmbeddedSignup, generateTwoStepPin, isTwoStepPin, retryEmbeddedSignupRegistration } from './embedded-signup-connect';
import { MetaApiError } from './meta-api';
import { PlanLimitError } from '@/lib/billing/entitlements';

const tenant = { accountId: ACCOUNT, userId: USER, role: 'admin' as const };
const input = { code: 'the-code', waba_id: '555', phone_number_id: '777' };

describe('origin and message helpers', () => {
  it('accepts only Facebook origins', () => {
    expect(isEmbeddedSignupOrigin('https://www.facebook.com')).toBe(true);
    expect(isEmbeddedSignupOrigin('https://web.facebook.com')).toBe(true);
    for (const o of ['https://facebook.com', 'http://www.facebook.com', 'https://www.facebook.com.evil.test', 'https://evil.test', 'null']) {
      expect(isEmbeddedSignupOrigin(o)).toBe(false);
    }
  });

  it('parses FINISH from string or object data, and ignores other origins', () => {
    const msg = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '1', phone_number_id: '2' } };
    expect(parseEmbeddedSignupMessage('https://www.facebook.com', JSON.stringify(msg))).toEqual({ kind: 'finish', wabaId: '1', phoneNumberId: '2' });
    expect(parseEmbeddedSignupMessage('https://web.facebook.com', msg)).toEqual({ kind: 'finish', wabaId: '1', phoneNumberId: '2' });
    expect(parseEmbeddedSignupMessage('https://evil.test', msg)).toBeNull();
  });

  it('rejects malformed ids, other types, and parses cancel and error', () => {
    const fb = 'https://www.facebook.com';
    expect(parseEmbeddedSignupMessage(fb, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '1/../x', phone_number_id: '2' } })).toBeNull();
    expect(parseEmbeddedSignupMessage(fb, { type: 'OTHER', event: 'FINISH', data: {} })).toBeNull();
    expect(parseEmbeddedSignupMessage(fb, '{not json')).toBeNull();
    expect(parseEmbeddedSignupMessage(fb, { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE' } })).toEqual({ kind: 'cancel', step: 'PHONE' });
    expect(parseEmbeddedSignupMessage(fb, { type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'x' } })).toEqual({ kind: 'error', message: 'x' });
  });

  it('validates the POST body', () => {
    expect(parseEmbeddedSignupRequest(input)).toEqual(input);
    expect(parseEmbeddedSignupRequest({ ...input, waba_id: 'abc' })).toBeNull();
    expect(parseEmbeddedSignupRequest({ ...input, phone_number_id: '+15551234' })).toBeNull();
    expect(parseEmbeddedSignupRequest({ ...input, code: '' })).toBeNull();
    expect(parseEmbeddedSignupRequest({ ...input, code: 'a b' })).toBeNull();
    expect(parseEmbeddedSignupRequest(null)).toBeNull();
  });
});

describe('secrets and PIN', () => {
  it('prefers META_APP_SECRET_PRIMARY, else the first comma-separated secret', () => {
    expect(codeExchangeSecret({ META_APP_SECRET: ' a , b ' })).toBe('a');
    expect(codeExchangeSecret({ META_APP_SECRET: 'a,b', META_APP_SECRET_PRIMARY: 'p' })).toBe('p');
    expect(codeExchangeSecret({})).toBeNull();
  });

  it('generates 6-digit PINs', () => {
    for (let i = 0; i < 50; i++) expect(generateTwoStepPin()).toMatch(/^\d{6}$/);
  });
});

describe('connectEmbeddedSignup', () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows = [];
    h.owner = null;
    h.failUpdateWith = null;
    process.env.NEXT_PUBLIC_META_APP_ID = '1234';
    process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID = '5678';
    process.env.META_APP_SECRET = 'first,second';
    delete process.env.META_APP_SECRET_PRIMARY;
    h.exchange.mockResolvedValue({ accessToken: 'tok' });
    h.verify.mockResolvedValue({ id: '777', display_phone_number: '+1 555', verified_name: 'Acme', quality_rating: 'GREEN' });
    h.list.mockResolvedValue([{ id: '777' }]);
    h.subscribe.mockResolvedValue(undefined);
    h.register.mockResolvedValue({ success: true, alreadyRegistered: false });
  });
  afterEach(() => { process.env = { ...env }; });

  it('runs every step, stores the token encrypted and returns the PIN once', async () => {
    const result = await connectEmbeddedSignup(tenant, input);
    expect(h.exchange).toHaveBeenCalledWith({ appId: '1234', appSecret: 'first', code: 'the-code' });
    expect(h.subscribe).toHaveBeenCalledWith({ wabaId: '555', accessToken: 'tok' });
    const pin = h.register.mock.calls[0][0].pin;
    expect(pin).toMatch(/^\d{6}$/);
    expect(result).toEqual({
      ok: true, created: true, pin,
      number: { id: 'cfg-1', phone_number_id: '777', waba_id: '555', display_name: 'Acme', status: 'connected', is_default: true },
    });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ access_token: 'enc(tok)', user_id: USER, account_id: ACCOUNT, quality_rating: 'GREEN' });
    expect(h.rows[0].registered_at).toBeInstanceOf(Date);
    expect(h.rows[0].subscribed_apps_at).toBeInstanceOf(Date);
    // Registering drops the forms key at Meta, so it is sent again.
    expect(h.reupload).toHaveBeenCalledWith(tenant, 'cfg-1', { phoneNumberId: '777', accessToken: 'tok' });
    expect(JSON.stringify(result)).not.toContain('tok');
  });

  it('is idempotent: a retry after a register failure reuses the row and skips finished steps', async () => {
    h.register.mockRejectedValueOnce(new MetaApiError('try later', { code: 1, httpStatus: 500 }));
    const first = await connectEmbeddedSignup(tenant, input);
    expect(first).toMatchObject({ ok: false, code: 'registerFailed', step: 'register' });
    expect(first).not.toHaveProperty('config_id');
    expect(h.rows[0].status).toBe('disconnected');
    expect(h.rows[0].last_registration_error).toBeTruthy();

    h.exchange.mockResolvedValueOnce({ accessToken: 'tok2' });
    const second = await connectEmbeddedSignup(tenant, { ...input, code: 'fresh-code' });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(h.rows).toHaveLength(1);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.register).toHaveBeenCalledTimes(2);
    expect(h.rows[0]).toMatchObject({ access_token: 'enc(tok2)', status: 'connected', last_registration_error: null });

    // A third run (reconnect) touches neither subscribe nor register.
    const third = await connectEmbeddedSignup(tenant, input);
    expect(third).toMatchObject({ ok: true, created: false, pin: null });
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.register).toHaveBeenCalledTimes(2);
  });

  it('refuses an additional number over the plan before any Meta change, but always lets an existing row reconnect', async () => {
    await connectEmbeddedSignup(tenant, input);
    expect(h.numberRoom).toHaveBeenCalledTimes(1);
    h.numberRoom.mockRejectedValue(new PlanLimitError('The Free plan allows up to 1 WhatsApp numbers. Upgrade for more.'));
    h.verify.mockResolvedValue({ id: '888', verified_name: 'Two' });
    h.list.mockResolvedValue([{ id: '777' }, { id: '888' }]);
    h.subscribe.mockClear();
    h.register.mockClear();
    await expect(connectEmbeddedSignup(tenant, { ...input, phone_number_id: '888' })).rejects.toBeInstanceOf(PlanLimitError);
    expect(h.rows).toHaveLength(1);
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    // The number it already has reconnects without consulting the limit.
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: true, created: false });
    expect(h.numberRoom).toHaveBeenCalledTimes(2);
    h.numberRoom.mockReset();
    h.numberRoom.mockResolvedValue(undefined);
  });

  it('re-subscribes when the number moved to another WABA', async () => {
    await connectEmbeddedSignup(tenant, input);
    h.list.mockResolvedValue([{ id: '777' }]);
    await connectEmbeddedSignup(tenant, { ...input, waba_id: '999' });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.rows[0].waba_id).toBe('999');
  });

  it('returns no PIN when Meta says the number was already registered', async () => {
    h.register.mockResolvedValue({ success: true, alreadyRegistered: true });
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: true, pin: null });
  });

  it('keeps the PIN in the error when Meta accepted it but saving failed', async () => {
    h.failUpdateWith = (data) => 'registered_at' in data;
    const result = await connectEmbeddedSignup(tenant, input);
    expect(result).toMatchObject({ ok: false, code: 'saveFailed', pin: h.register.mock.calls[0][0].pin });
  });

  it('maps each early failure without writing a row', async () => {
    h.exchange.mockRejectedValueOnce(new MetaApiError('bad code', { httpStatus: 400, code: 100 }));
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: false, status: 400, code: 'codeExchangeFailed' });

    h.verify.mockRejectedValueOnce(new MetaApiError('no access', { httpStatus: 400, code: 100 }));
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: false, code: 'numberNotAccessible', step: 'verify_number' });

    h.list.mockResolvedValueOnce([{ id: '888' }]);
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: false, status: 400, code: 'wabaMismatch' });

    h.owner = '33333333-3333-4333-8333-333333333333';
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: false, status: 409, code: 'numberLinkedElsewhere' });
    expect(h.rows).toHaveLength(0);
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
  });

  it('records the checkpoint before a subscribe failure', async () => {
    h.subscribe.mockRejectedValueOnce(new MetaApiError('nope', { httpStatus: 403, code: 200 }));
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: false, code: 'subscribeFailed', step: 'subscribe_waba' });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ status: 'disconnected', subscribed_apps_at: null });
    expect(h.register).not.toHaveBeenCalled();
  });

  it('answers notConfigured without calling Meta when env is missing', async () => {
    delete process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID;
    expect(await connectEmbeddedSignup(tenant, input)).toMatchObject({ ok: false, status: 503, code: 'notConfigured' });
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("uses the admin's existing PIN for register and never returns it", async () => {
    const result = await connectEmbeddedSignup(tenant, input, { pin: '004321' });
    expect(h.register).toHaveBeenCalledWith({ phoneNumberId: '777', accessToken: 'tok', pin: '004321' });
    expect(result).toMatchObject({ ok: true, pin: null });
    expect(JSON.stringify(result)).not.toContain('004321');
  });

  it('answers pinMismatch with the row id; a retry with the right PIN finishes without a new code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.register.mockRejectedValueOnce(new MetaApiError('PIN mismatch', { code: 133005, httpStatus: 400 }));
    const first = await connectEmbeddedSignup(tenant, input);
    expect(first).toEqual(expect.objectContaining({ ok: false, status: 400, code: 'pinMismatch', step: 'register', config_id: 'cfg-1' }));
    expect(first).not.toHaveProperty('pin');
    expect(h.rows[0]).toMatchObject({ status: 'disconnected', registered_at: null });
    expect(h.rows[0].last_registration_error).toBeTruthy();

    const retried = await retryEmbeddedSignupRegistration(tenant, { config_id: 'cfg-1', pin: '135790' });
    expect(retried).toMatchObject({ ok: true, created: false, pin: null, number: { id: 'cfg-1', status: 'connected' } });
    expect(h.exchange).toHaveBeenCalledTimes(1);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.register).toHaveBeenLastCalledWith({ phoneNumberId: '777', accessToken: 'tok', pin: '135790' });
    expect(h.rows[0]).toMatchObject({ status: 'connected', last_registration_error: null });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/135790|tok/);
    spy.mockRestore();
  });

  it('maps Meta PIN lockout to pinLocked and keeps the row retryable', async () => {
    h.register.mockRejectedValueOnce(new MetaApiError('locked', { code: 133008, httpStatus: 400 }));
    const first = await connectEmbeddedSignup(tenant, input, { pin: '111111' });
    expect(first).toMatchObject({ ok: false, code: 'pinLocked', config_id: 'cfg-1' });
  });

  it("refuses a retry for a row that is not this workspace's or has no token", async () => {
    h.rows.push({
      id: 'cfg-other', account_id: '99999999-9999-4999-8999-999999999999', user_id: USER, phone_number_id: '888', waba_id: '555',
      access_token: 'enc(other)', display_name: null, quality_rating: null, status: 'disconnected', is_default: true,
      registered_at: null, subscribed_apps_at: null, connected_at: null, last_registration_error: null,
    });
    expect(await retryEmbeddedSignupRegistration(tenant, { config_id: 'cfg-other', pin: '123456' })).toMatchObject({ ok: false, status: 404, code: 'notFound' });
    expect(await retryEmbeddedSignupRegistration(tenant, { config_id: 'missing', pin: '123456' })).toMatchObject({ ok: false, code: 'notFound' });
    expect(h.register).not.toHaveBeenCalled();
  });

  it('validates admin PINs as exactly 6 digits', () => {
    expect(isTwoStepPin('012345')).toBe(true);
    for (const v of ['12345', '1234567', '12345a', ' 123456', 123456, null]) expect(isTwoStepPin(v)).toBe(false);
  });

  it('never logs the code or token', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.exchange.mockRejectedValueOnce(new MetaApiError('bad the-code', { httpStatus: 400 }));
    await connectEmbeddedSignup(tenant, input);
    h.subscribe.mockRejectedValueOnce(new MetaApiError('tok rejected', { httpStatus: 400 }));
    await connectEmbeddedSignup(tenant, input);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('the-code');
    expect(logged).not.toContain('tok');
    spy.mockRestore();
  });
});
