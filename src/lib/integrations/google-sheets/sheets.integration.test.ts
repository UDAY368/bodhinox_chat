/// <reference types="vite/client" />
// Stage 5 (5G) Google Sheets on a real PostgreSQL: the refresh token never
// reaches a browser response or the app role, connect and disconnect need an
// admin with Origin + CSRF, tenancy holds, and a repeated step execution
// appends one row. Google is never reached: fetch is stubbed and counted.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest, type TenantPair,
} from '@/test/tenancy/fixtures';
import type { FlowNodeRow, FlowRunRow } from '@/lib/flows/types';
import { GET, DELETE } from '@/app/api/integrations/google-sheets/route';
import { POST as CONNECT } from '@/app/api/integrations/google-sheets/connect/route';
import { executeSheetsNode } from './node';
import { forgetAccessToken } from './connection';

const databases = fixtureDatabaseUrls();
const SECRET = `test-only-refresh-${randomUUID()}`;
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const connectionRow = (accountId: string, userId: string, token: string) => fixtureOwnerPool().query(
  "INSERT INTO google_sheets_connections(account_id,google_email,refresh_token_encrypted,status,connected_by) VALUES($1,'owner@shop.example',$2,'active',$3)",
  [accountId, encrypt(token), userId]);
const rowsOf = async (accountId: string) =>
  (await fixtureOwnerPool().query('SELECT id, refresh_token_encrypted FROM google_sheets_connections WHERE account_id=$1', [accountId])).rows;

describe.skipIf(!databases)('Google Sheets connection and step (real database)', () => {
  let pair: TenantPair;
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => json(500, {}));

  beforeAll(async () => {
    pair = await createTenantPair({ label: 's5g' });
  }, 120000);
  beforeEach(async () => {
    vi.stubEnv('GOOGLE_SHEETS_ENABLED', 'true');
    vi.stubEnv('GOOGLE_SHEETS_CLIENT_ID', 'test-client.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_SHEETS_CLIENT_SECRET', 'test-only-client-secret');
    fetcher.mockReset();
    fetcher.mockImplementation(async () => json(500, {}));
    vi.stubGlobal('fetch', fetcher);
    for (const t of [pair.a, pair.b]) {
      await fixtureOwnerPool().query('DELETE FROM google_sheets_connections WHERE account_id=$1', [t.accountId]);
      forgetAccessToken(t.accountId);
    }
    await connectionRow(pair.a.accountId, pair.a.users.owner.userId, SECRET);
    await connectionRow(pair.b.accountId, pair.b.users.owner.userId, `${SECRET}-b`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('any member sees the status, never the token', async () => {
    const encrypted = (await rowsOf(pair.a.accountId))[0].refresh_token_encrypted as string;
    for (const role of ['viewer', 'agent', 'admin', 'owner'] as const) {
      const response = await GET(await signedRequest(pair.a.users[role], 'GET', '/api/integrations/google-sheets'));
      expect(response.status, role).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(encrypted);
      expect(JSON.parse(text)).toMatchObject({ available: true, connected: true, google_email: 'owner@shop.example' });
    }
  }, 60000);

  it('the app role cannot read the token column even as an admin', async () => {
    await expect(withTenant(pair.a.users.admin.context, (tx) => tx.$queryRaw`SELECT refresh_token_encrypted FROM google_sheets_connections`, getPrisma()))
      .rejects.toThrow();
  }, 30000);

  it('disconnect needs an admin with CSRF, removes only this workspace and revokes at Google', async () => {
    fetcher.mockImplementation(async () => json(200, {}));
    expect((await DELETE(await signedRequest(pair.a.users.agent, 'DELETE', '/api/integrations/google-sheets'))).status).toBe(403);
    expect((await DELETE(await signedRequest(pair.a.users.admin, 'DELETE', '/api/integrations/google-sheets', undefined, { omitCsrf: true }))).status).toBe(403);
    expect(await rowsOf(pair.a.accountId)).toHaveLength(1);
    const done = await DELETE(await signedRequest(pair.a.users.admin, 'DELETE', '/api/integrations/google-sheets'));
    expect(done.status).toBe(200);
    expect(await done.text()).not.toContain(SECRET);
    expect(await rowsOf(pair.a.accountId)).toHaveLength(0);
    expect(await rowsOf(pair.b.accountId)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith('https://oauth2.googleapis.com/revoke', expect.anything());
    const audit = await fixtureOwnerPool().query("SELECT metadata::text AS m FROM audit_logs WHERE account_id=$1 AND action='integrations.google_sheets_disconnect'", [pair.a.accountId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].m).not.toContain(SECRET);
  }, 60000);

  it('connect needs an admin with CSRF and points at Google with PKCE and a signed state cookie', async () => {
    expect((await CONNECT(await signedRequest(pair.a.users.agent, 'POST', '/api/integrations/google-sheets/connect'))).status).toBe(403);
    expect((await CONNECT(await signedRequest(pair.a.users.admin, 'POST', '/api/integrations/google-sheets/connect', undefined, { omitCsrf: true }))).status).toBe(403);
    const response = await CONNECT(await signedRequest(pair.a.users.admin, 'POST', '/api/integrations/google-sheets/connect'));
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(response.headers.get('set-cookie')).toMatch(/bx_gsheets_oauth=.+HttpOnly/i);
    expect(fetcher).not.toHaveBeenCalled();
  }, 60000);

  it('a repeated execution of the same step appends one row', async () => {
    const appends: string[] = [];
    fetcher.mockImplementation(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'test-access', expires_in: 3600 });
      if (url.includes(':append')) appends.push(url);
      return json(200, {});
    });
    const run = { id: randomUUID(), account_id: pair.a.accountId, transition_seq: 1, vars: { email: 'lead@shop.example' } } as unknown as FlowRunRow;
    const node = { node_key: 'sheet_1', node_type: 'google_sheets', config: {
      op: 'insert_row', spreadsheet_id: SHEET_ID, sheet: 'Leads', columns: [{ column: 'A', value: '{{vars.email}}' }], next: 'n', failure_next: 'f',
    } } as unknown as FlowNodeRow;
    expect(await executeSheetsNode(run, node)).toEqual({ port: 'next', vars: {} });
    expect(await executeSheetsNode(run, node)).toEqual({ port: 'next', vars: {} });
    expect(appends).toHaveLength(1);
    // A's run used A's own connection, never B's.
    const tokenBodies = fetcher.mock.calls.filter(([u]) => u === 'https://oauth2.googleapis.com/token').map(([, init]) => String(init?.body));
    expect(tokenBodies.length).toBeGreaterThan(0);
    expect(tokenBodies.every((body) => body.includes(`refresh_token=${SECRET}&`) && !body.includes(`${SECRET}-b`))).toBe(true);
  }, 60000);

  it('an unknown outcome is not retried: the next execution follows the failure port', async () => {
    let appends = 0;
    fetcher.mockImplementation(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'test-access', expires_in: 3600 });
      if (url.includes(':append')) { appends += 1; return json(503, {}); }
      return json(200, {});
    });
    const run = { id: randomUUID(), account_id: pair.a.accountId, transition_seq: 1, vars: {} } as unknown as FlowRunRow;
    const node = { node_key: 'sheet_2', node_type: 'google_sheets', config: {
      op: 'insert_row', spreadsheet_id: SHEET_ID, sheet: 'Leads', columns: [{ column: 'A', value: 'x' }], next: 'n', failure_next: 'f',
    } } as unknown as FlowNodeRow;
    expect(await executeSheetsNode(run, node)).toMatchObject({ port: 'failure', reason: 'sheets_outcome_unknown' });
    expect(await executeSheetsNode(run, node)).toMatchObject({ port: 'failure', reason: 'sheets_outcome_unknown' });
    expect(appends).toBe(1);
  }, 60000);
});
