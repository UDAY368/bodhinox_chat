import { beforeEach, describe, expect, it, vi } from 'vitest';

// finishZoomConnect's grant policy: a grant that is not stored is revoked only
// when its Zoom account is identified and no workspace holds it live, because
// Zoom's revoke de-authorizes the app on the whole Zoom account.
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ALL_SCOPES = ['meeting:write:admin', 'meeting:read:admin', 'user:read:admin'];

const h = vi.hoisted(() => ({
  scopes: null as string[] | null,
  me: { id: 'zuser', account_id: 'zacct' } as unknown,
  meFails: false,
  heldElsewhere: false,
  insertConflict: false,
  liveRow: false,
  revoked: [] as string[],
  sql: [] as string[],
}));

vi.mock('./config', () => ({ zoomConfig: () => ({ clientId: 'cid', clientSecret: 'csecret', webhookSecretToken: 'wh' }) }));
vi.mock('@/lib/auth/csrf', () => ({ appOrigin: () => 'http://localhost:3000' }));
vi.mock('@/lib/billing/entitlements', () => ({ getEntitlements: async () => ({ features: { online_meetings: true } }) }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/payments/ledger', () => ({ auditTx: async () => {} }));
vi.mock('./jobs', () => ({ backfillMeetingSyncTx: async () => 0 }));
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }));
vi.mock('./zoom-client', () => {
  class ZoomError extends Error {
    constructor(readonly kind: string, readonly status: number | null, readonly code: string | null) { super(kind); }
  }
  return {
    ZoomError,
    zoomTokenRequest: async () => ({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresInSeconds: 3600, scopes: h.scopes }),
    zoomCall: async () => { if (h.meFails) throw new ZoomError('unknown', null, 'timeout'); return h.me; },
    zoomRevoke: async (_c: unknown, token: string) => { h.revoked.push(token); return true; },
  };
});
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { h.sql.push(`${strings.join('?')} ${values.join(',')}`); return 1; },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      h.sql.push(text);
      if (text.includes('FOR UPDATE')) return h.liveRow ? [{ id: 'conn1', zoom_account_id: 'zacct' }] : [];
      if (text.includes('SELECT id::text AS id FROM meeting_connections')) return h.liveRow ? [{ id: 'conn1' }] : [];
      if (text.includes('crm_resolve_zoom_connection')) return h.heldElsewhere ? [{ account_id: 'other' }] : [];
      if (text.includes('INSERT INTO meeting_connections')) {
        if (h.insertConflict) throw Object.assign(new Error('unique'), { code: 'P2002' });
        return [{ id: '33333333-3333-4333-8333-333333333333' }];
      }
      if (text.includes('SELECT status, register_attendees')) return [{ status: 'active', register_attendees: false, last_error_code: null, connected_at: new Date() }];
      return [];
    },
  }),
}));

import { finishZoomConnect, startZoomConnect } from './connection';

const actor = { accountId: ACCOUNT, userId: USER, role: 'owner' as const };
async function connect() {
  const { authorizeUrl, cookie } = await startZoomConnect(actor);
  const state = new URL(authorizeUrl).searchParams.get('state')!;
  return finishZoomConnect(actor, { code: 'code1', state, cookie });
}

beforeEach(() => {
  Object.assign(h, { scopes: ALL_SCOPES, me: { id: 'zuser', account_id: 'zacct' }, meFails: false, heldElsewhere: false,
    insertConflict: false, liveRow: false, revoked: [], sql: [] });
});

describe('finishZoomConnect grant policy', () => {
  it('never revokes when another workspace already holds the Zoom account', async () => {
    h.insertConflict = true;
    await expect(connect()).rejects.toMatchObject({ code: 'zoom_account_in_use' });
    expect(h.revoked).toEqual([]);
  });

  it('on missing scopes, revokes only an identified grant whose Zoom account nobody holds', async () => {
    h.scopes = ['meeting:write:admin'];
    await expect(connect()).rejects.toMatchObject({ code: 'missing_scopes' });
    expect(h.revoked).toEqual(['access-new']);

    h.revoked = []; h.heldElsewhere = true;
    await expect(connect()).rejects.toMatchObject({ code: 'missing_scopes' });
    expect(h.revoked).toEqual([]);

    // Not identifiable (users/me refused for lack of the user scope): left to expire.
    h.revoked = []; h.heldElsewhere = false; h.meFails = true;
    await expect(connect()).rejects.toMatchObject({ code: 'missing_scopes' });
    expect(h.revoked).toEqual([]);
  });

  it('never revokes when /users/me fails or names no valid account', async () => {
    h.meFails = true;
    await expect(connect()).rejects.toMatchObject({ code: 'provider_unreachable' });
    h.meFails = false; h.me = { id: 'zuser', account_id: 'bad id!' };
    await expect(connect()).rejects.toMatchObject({ code: 'provider_unreachable' });
    expect(h.revoked).toEqual([]);
  });

  it('on reconnect takes the kept row\'s token lock after the connection lock, before locking the row', async () => {
    h.liveRow = true;
    await connect();
    const conn = h.sql.findIndex((t) => t.includes('pg_advisory_xact_lock') && t.includes(`zoom-conn:${ACCOUNT}`));
    const token = h.sql.findIndex((t) => t.includes('pg_advisory_xact_lock') && t.includes('zoom-token:conn1'));
    const forUpdate = h.sql.findIndex((t) => t.includes('FOR UPDATE'));
    expect(conn).toBeGreaterThanOrEqual(0);
    expect(token).toBeGreaterThan(conn);
    expect(forUpdate).toBeGreaterThan(token);
    expect(h.sql.some((t) => t.includes("UPDATE meeting_connections SET status='active'"))).toBe(true);
    expect(h.revoked).toEqual([]);
  });
});
