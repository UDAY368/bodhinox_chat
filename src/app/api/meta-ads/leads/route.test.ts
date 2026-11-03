import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'agent', mask: false, session: vi.fn(),
  listLeads: vi.fn(), forms: vi.fn(), exportCsv: vi.fn(), deleteLead: vi.fn(), permission: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireSession: h.session }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/meta-ads/leads', async (orig) => ({
  ...(await orig<typeof import('@/lib/meta-ads/leads')>()),
  listLeads: h.listLeads, listLeadFormOptions: h.forms, exportLeadsCsv: h.exportCsv, deleteLead: h.deleteLead,
}));
vi.mock('@/lib/inbox/masking-apply', () => ({ resolvePhoneMask: async () => h.mask }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.permission }));

import { GET as listGET } from './route';
import { GET as formsGET } from './forms/route';
import { GET as exportGET } from './export/route';
import { DELETE } from './[id]/route';

const env = { META_ADS_ENABLED: 'true', META_APP_ID: '1', META_APP_SECRET: 's', META_ADS_LOGIN_CONFIG_ID: '2' };
const enable = () => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };
const req = (path: string, init?: RequestInit) => new Request(`http://localhost/api/meta-ads/leads${path}`, init);
const del = (id: string) => DELETE(req(`/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.mask = false;
  h.session.mockImplementation(async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }));
  h.permission.mockResolvedValue(undefined);
  h.listLeads.mockResolvedValue({ leads: [], nextCursor: null });
  h.forms.mockResolvedValue([{ id: '555', name: 'Form' }]);
  h.exportCsv.mockResolvedValue({ csv: 'a\r\n', rows: 1 });
  h.deleteLead.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe('while Meta ads are not enabled', () => {
  it('the list, forms and export routes answer 503 before the session, DB or Meta is touched', async () => {
    for (const res of [await listGET(req('')), await formsGET(), await exportGET(req('/export'))]) {
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('meta_ads_not_enabled');
    }
    expect(h.session).not.toHaveBeenCalled();
    for (const fn of [h.listLeads, h.forms, h.exportCsv]) expect(fn).not.toHaveBeenCalled();
  });

  it('still lets an admin erase a lead, and only an admin', async () => {
    expect((await del(LEAD)).status).toBe(403);
    expect(h.deleteLead).not.toHaveBeenCalled();
    h.role = 'admin';
    expect((await del(LEAD)).status).toBe(200);
    expect(h.deleteLead).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER }, LEAD);
  });
});

describe('when enabled', () => {
  it('lists leads for any member with a validated filter and no-store', async () => {
    enable();
    const res = await listGET(req('?formId=555&from=2026-11-01'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.listLeads).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, expect.objectContaining({ formId: '555', from: '2026-11-01' }));
    expect((await listGET(req('?adId=act_1'))).status).toBe(400);
    // A day that does not exist is a 400, not a Postgres ::date error (500).
    expect((await listGET(req('?from=2026-02-31'))).status).toBe(400);
    expect(h.listLeads).toHaveBeenCalledTimes(1);
    expect((await formsGET()).status).toBe(200);
  });

  it('limits export and delete to admins', async () => {
    enable();
    expect((await exportGET(req('/export'))).status).toBe(403);
    expect((await del(LEAD)).status).toBe(403);
    expect(h.exportCsv).not.toHaveBeenCalled();
    expect(h.deleteLead).not.toHaveBeenCalled();
  });

  it('exports CSV for an admin, unless masked', async () => {
    enable();
    h.role = 'admin';
    const res = await exportGET(req('/export?formId=555'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(h.exportCsv).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, expect.objectContaining({ formId: '555' }));
    h.mask = true;
    expect((await exportGET(req('/export'))).status).toBe(403);
  });

  it('deletes a lead for an admin; unknown or malformed ids are 404', async () => {
    enable();
    h.role = 'admin';
    expect((await del(LEAD)).status).toBe(200);
    expect(h.deleteLead).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER }, LEAD);
    h.deleteLead.mockResolvedValueOnce(false);
    expect((await del(LEAD)).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(404);
  });
});
