import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Zoom is a fake in this file: every HTTP call goes through leaseFetch, which is
// mocked, so nothing ever reaches zoom.us. The fake keeps meetings in memory
// and can answer a create with a timeout (after making the meeting), a 4xx, or
// pause until the test releases it.
type Mode = 'ok' | 'timeout' | 'reject' | 'pause';
interface FakeMeeting { id: number; topic: string; join_url: string; start_time: string; duration: number; host: string }
const zoom = {
  meetings: new Map<number, FakeMeeting>(),
  calls: [] as { method: string; path: string }[],
  createMode: 'ok' as Mode,
  refreshMode: 'ok' as 'ok' | 'invalid',
  refreshes: 0,
  nextId: 81_000_000_000,
  paused: null as null | { reached: () => void; release: Promise<void> },
  meAccount: '',
  /** Access tokens the API answers 401 to ('*' = every token). */
  refused: new Set<string>(),
  lastExchange: null as URLSearchParams | null,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeZoom(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  zoom.calls.push({ method, path: url.pathname });
  if (url.host === 'zoom.us' && url.pathname === '/oauth/token') {
    const form = new URLSearchParams(String(init?.body));
    if (form.get('grant_type') === 'authorization_code') {
      zoom.lastExchange = form;
      return json(200, { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
        scope: 'meeting:write:meeting:admin meeting:update:meeting:admin meeting:delete:meeting:admin meeting:read:list_meetings:admin user:read:user:admin' });
    }
    zoom.refreshes++;
    await new Promise((r) => setTimeout(r, 50));
    if (zoom.refreshMode === 'invalid') return json(400, { reason: 'Invalid Token!', error: 'invalid_grant' });
    return json(200, { access_token: `access-${zoom.refreshes}`, refresh_token: `refresh-${zoom.refreshes}`, expires_in: 3600,
      scope: 'meeting:write:admin meeting:read:admin user:read:admin' });
  }
  if (url.host === 'zoom.us' && url.pathname === '/oauth/revoke') return json(200, { status: 'success' });
  const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, '');
  if (url.pathname.startsWith('/v2/') && (zoom.refused.has('*') || zoom.refused.has(bearer))) return json(401, { code: 124, message: 'Invalid access token.' });
  if (url.pathname === '/v2/users/me') return json(200, { id: 'zuserB', account_id: zoom.meAccount, email: 'never-stored@example.invalid' });
  const create = url.pathname.match(/^\/v2\/users\/([^/]+)\/meetings$/);
  if (create && method === 'POST') {
    if (zoom.createMode === 'reject') return json(400, { code: 300, message: 'Invalid host' });
    if (zoom.createMode === 'pause' && zoom.paused) { zoom.paused.reached(); await zoom.paused.release; }
    const body = JSON.parse(String(init?.body)) as { topic: string; start_time: string; duration: number };
    const id = zoom.nextId++;
    const meeting = { id, topic: body.topic, join_url: `https://zoom.example/j/${id}`, start_time: body.start_time, duration: body.duration,
      host: decodeURIComponent(create[1]) };
    zoom.meetings.set(id, meeting);
    if (zoom.createMode === 'timeout') { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
    return json(201, meeting);
  }
  if (create && method === 'GET') {
    const host = decodeURIComponent(create[1]);
    return json(200, { meetings: [...zoom.meetings.values()].filter((m) => m.host === host), next_page_token: '' });
  }
  const one = url.pathname.match(/^\/v2\/meetings\/(\d+)$/);
  if (one) {
    const meeting = zoom.meetings.get(Number(one[1]));
    if (!meeting) return json(404, { code: 3001, message: 'Meeting does not exist' });
    if (method === 'DELETE') { zoom.meetings.delete(meeting.id); return new Response(null, { status: 204 }); }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { start_time: string; duration: number };
      Object.assign(meeting, { start_time: body.start_time, duration: body.duration });
      return new Response(null, { status: 204 });
    }
  }
  return json(404, { code: 1, message: 'unexpected' });
}

vi.mock('@/lib/jobs/lease', () => ({
  leaseFetch: (input: RequestInfo | URL, init?: RequestInit) => fakeZoom(input, init),
  assertJobLease: () => {},
  withLeaseScope: <T>(_g: () => void, work: () => T) => work(),
}));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  disconnectZoom, finishZoomConnect, getMeetingConnection, getZoomAccessToken, markZoomTokenRejected, pkceChallenge, readZoomState,
  startZoomConnect,
} from './connection';
import { enqueueMeetingSync, handleMeetingSyncJob, MeetingSyncRetry, recreateMeeting, sweepMeetings, useSuppliedLink } from './sync';
import { MeetingError } from './types';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const ids = {
  location: randomUUID(), service: randomUUID(), staff: randomUUID(), staff2: randomUUID(), conn: randomUUID(),
  locationB: randomUUID(), serviceB: randomUUID(), staffB: randomUUID(),
};
const zoomAccount = `zacct${randomUUID().slice(0, 8)}`;
const SUPPLIED = 'https://meet.example/supplied';
const meta = { attempts: 1, maxAttempts: 5 };
const ENV_KEYS = ['ZOOM_ENABLED', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_WEBHOOK_SECRET_TOKEN', 'APP_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
let owner: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await owner.query(sql, values)).rows as T[];
const posts = () => zoom.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/meetings')).length;
const apiCalls = () => zoom.calls.filter((c) => c.path.startsWith('/v2/')).length;
const meetingOf = async (appointmentId: string) => (await q<{
  sync_state: string; external_meeting_id: string | null; join_url: string | null; meeting_ref: string; claim_token: string | null;
  synced_start_at: Date | null; host_zoom_user: string | null; supplied_url: string | null; last_error_code: string | null;
}>(`SELECT sync_state, external_meeting_id, join_url, meeting_ref, claim_token, synced_start_at, host_zoom_user, supplied_url, last_error_code
    FROM appointment_meetings WHERE appointment_id=$1`, [appointmentId]))[0];
const urlOf = async (appointmentId: string) => (await q<{ meeting_url: string | null }>('SELECT meeting_url FROM appointments WHERE id=$1', [appointmentId]))[0].meeting_url;
const versionOf = async (appointmentId: string) => (await q<{ version: number }>('SELECT version FROM appointments WHERE id=$1', [appointmentId]))[0].version;
const events = async (appointmentId: string) =>
  (await q<{ kind: string }>('SELECT kind FROM appointment_events WHERE appointment_id=$1 ORDER BY created_at', [appointmentId])).map((r) => r.kind);
const tasks = async (appointmentId: string) =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE appointment_id=$1 AND kind='meeting_sync' AND status='open'`, [appointmentId]))[0].n;

async function book(account = accountA, opts: { service?: string; staff?: string; location?: string } = {}): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO appointments(id,account_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,confirmed_at,
      service_name,meeting_url) VALUES($1,$2,$3,$4,$5,now()+interval '3 days',now()+interval '3 days 30 minutes','Asia/Kolkata',
      'confirmed','staff',now(),'Consult',$6)`,
  [id, account, opts.service ?? ids.service, opts.staff ?? ids.staff, opts.location ?? ids.location, SUPPLIED]);
  return id;
}
const change = async (id: string, set: string) => {
  await q(`UPDATE appointments SET ${set}, version=version+1 WHERE id=$1`, [id]);
  return versionOf(id);
};
const run = async (id: string, account = accountA, m = meta) => handleMeetingSyncJob(account, { appointmentId: id, version: await versionOf(id) }, m);
const enqueue = (id: string, account = accountA, service = ids.service) =>
  withTenant({ accountId: account, role: 'owner' }, (tx) => enqueueMeetingSync(tx, account, { id, service_id: service, status: 'confirmed' }, 1),
    getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Zoom meeting sync on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    Object.assign(process.env, { ZOOM_ENABLED: 'true', ZOOM_CLIENT_ID: 'test-client', ZOOM_CLIENT_SECRET: 'test-only-secret',
      ZOOM_WEBHOOK_SECRET_TOKEN: 'test-only-webhook', APP_URL: 'http://localhost:3000' });
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P9 sync', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Sync A',$2),($3,'Sync B',$4)", [accountA, ownerA, accountB, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    for (const [acct, loc, svc, staff] of [[accountA, ids.location, ids.service, ids.staff], [accountB, ids.locationB, ids.serviceB, ids.staffB]]) {
      await q("INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES($1,$2,'Clinic','Asia/Kolkata')", [loc, acct]);
      await q("INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes,meeting_url) VALUES($1,$2,'Consult','online',30,$3)", [svc, acct, SUPPLIED]);
      await q("INSERT INTO appointment_staff(id,account_id,display_name) VALUES($1,$2,'Dr A')", [staff, acct]);
    }
    await q("INSERT INTO appointment_staff(id,account_id,display_name,meeting_host_email) VALUES($1,$2,'Dr B','dr.b@example.invalid')", [ids.staff2, accountA]);
    await q(`INSERT INTO meeting_connections(id,account_id,zoom_account_id,authorized_zoom_user_id,access_token_enc,refresh_token_enc,
        token_expires_at,refresh_rotated_at) VALUES($1,$2,$3,'zuserA',$4,$5,now()+interval '1 hour',now())`,
    [ids.conn, accountA, zoomAccount, encrypt('access-0'), encrypt('refresh-0')]);
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    if (owner) {
      await q('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  beforeEach(() => {
    zoom.calls = [];
    zoom.createMode = 'ok';
    zoom.refreshMode = 'ok';
    zoom.refused = new Set();
  });

  it('queues nothing and calls nothing without config or without a connection', async () => {
    const id = await book();
    delete process.env.ZOOM_ENABLED;
    try {
      expect(await enqueue(id)).toBe(false);
      await run(id);
    } finally {
      process.env.ZOOM_ENABLED = 'true';
    }
    const idB = await book(accountB, { service: ids.serviceB, staff: ids.staffB, location: ids.locationB });
    expect(await enqueue(idB, accountB, ids.serviceB)).toBe(false);
    await run(idB, accountB);
    expect(await q('SELECT 1 FROM jobs WHERE dedupe_key = ANY($1)', [[`appt-mtg:${id}:v1`, `appt-mtg:${idB}:v1`]])).toEqual([]);
    expect(zoom.calls).toEqual([]);
    expect(await meetingOf(idB)).toBeUndefined();
  });

  it('queues one job per version when connected', async () => {
    const id = await book();
    expect(await enqueue(id)).toBe(true);
    expect(await enqueue(id)).toBe(false);
    expect(await q('SELECT type FROM jobs WHERE dedupe_key=$1', [`appt-mtg:${id}:v1`])).toEqual([{ type: 'appointments.meeting_sync' }]);
    expect(zoom.calls).toEqual([]);
  });

  it('creates exactly one meeting, and a replayed job creates none', async () => {
    const id = await book();
    await run(id);
    expect(posts()).toBe(1);
    const m = await meetingOf(id);
    expect(m).toMatchObject({ sync_state: 'active', supplied_url: SUPPLIED, host_zoom_user: 'zuserA', claim_token: null });
    expect(m.external_meeting_id).toMatch(/^\d+$/);
    expect(await urlOf(id)).toBe(m.join_url);
    // The topic carries the service name and the reference only.
    expect(zoom.meetings.get(Number(m.external_meeting_id))?.topic).toBe(`Consult · ${m.meeting_ref}`);
    expect(await events(id)).toEqual(['meeting_created']);
    await run(id);
    expect(posts()).toBe(1);
  });

  it('reconciles an ambiguous create by its reference and never posts again', async () => {
    const id = await book();
    zoom.createMode = 'timeout';
    await expect(run(id)).rejects.toBeInstanceOf(MeetingSyncRetry);
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'unknown', claim_token: null });
    zoom.createMode = 'ok';
    zoom.calls = [];
    await run(id);
    expect(posts()).toBe(0);
    expect(zoom.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    const m = await meetingOf(id);
    expect(m.sync_state).toBe('active');
    expect(zoom.meetings.get(Number(m.external_meeting_id))?.topic).toContain(m.meeting_ref);
    expect(await urlOf(id)).toBe(m.join_url);
  });

  it('opens one task after the last ambiguous attempt', async () => {
    const id = await book();
    zoom.createMode = 'timeout';
    await expect(run(id)).rejects.toBeInstanceOf(MeetingSyncRetry);
    // The meeting the lost response made disappears, so reconcile finds nothing.
    zoom.meetings.clear();
    await expect(run(id)).rejects.toBeInstanceOf(MeetingSyncRetry);
    await run(id, accountA, { attempts: 5, maxAttempts: 5 });
    await run(id, accountA, { attempts: 5, maxAttempts: 5 });
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'unknown' });
    expect(await tasks(id)).toBe(1);
    expect(posts()).toBe(1);
    // Use supplied link: manual, the supplied link is restored, nothing is called.
    zoom.calls = [];
    await useSuppliedLink({ accountId: accountA, userId: ownerA, role: 'owner' }, id);
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'manual' });
    expect(await urlOf(id)).toBe(SUPPLIED);
    await run(id);
    expect(zoom.calls).toEqual([]);
  });

  it('marks a refused create failed with one task and one event; Create again makes a new meeting', async () => {
    const id = await book();
    zoom.createMode = 'reject';
    await run(id);
    await run(id);
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'failed', last_error_code: 'zoom_300' });
    expect(await tasks(id)).toBe(1);
    expect(await events(id)).toEqual(['meeting_sync_failed']);
    expect(await urlOf(id)).toBe(SUPPLIED);
    expect(posts()).toBe(1);

    zoom.createMode = 'ok';
    const before = (await meetingOf(id)).meeting_ref;
    await recreateMeeting({ accountId: accountA, userId: ownerA, role: 'owner' }, id);
    const [job] = await q<{ payload: { appointmentId: string; version: number } }>(
      "SELECT payload FROM jobs WHERE dedupe_key LIKE $1", [`appt-mtg:${id}:v1:re:%`]);
    expect(job.payload).toEqual({ appointmentId: id, version: 1 });
    await run(id);
    const m = await meetingOf(id);
    expect(m.sync_state).toBe('active');
    expect(m.meeting_ref).not.toBe(before);
    expect(posts()).toBe(2);
    expect(await q("SELECT action FROM audit_logs WHERE account_id=$1 AND resource_id=$2", [accountA, id]))
      .toEqual([{ action: 'appointments.meeting_recreate' }]);
  });

  it('patches a reschedule, re-hosts a reassignment and deletes on cancel', async () => {
    const id = await book();
    await run(id);
    const created = await meetingOf(id);
    zoom.calls = [];
    await change(id, "start_at=start_at+interval '1 day', end_at=end_at+interval '1 day'");
    await run(id);
    expect(zoom.calls.map((c) => c.method)).toEqual(['PATCH']);
    const patched = await meetingOf(id);
    expect(patched.synced_start_at?.getTime()).toBeGreaterThan(created.synced_start_at!.getTime());
    expect(zoom.meetings.get(Number(created.external_meeting_id))?.start_time).toBe(patched.synced_start_at!.toISOString().replace(/\.\d{3}Z$/, 'Z'));

    zoom.calls = [];
    await change(id, `staff_id='${ids.staff2}'`);
    await run(id);
    expect(zoom.calls.map((c) => c.method)).toEqual(['DELETE', 'POST']);
    const rehosted = await meetingOf(id);
    expect(rehosted).toMatchObject({ sync_state: 'active', host_zoom_user: 'dr.b@example.invalid' });
    expect(rehosted.meeting_ref).not.toBe(created.meeting_ref);
    expect(zoom.meetings.has(Number(created.external_meeting_id))).toBe(false);

    zoom.calls = [];
    // Already gone in Zoom: a 404 on delete is success.
    zoom.meetings.delete(Number(rehosted.external_meeting_id));
    await change(id, "status='cancelled', cancel_reason='staff'");
    await run(id);
    expect(zoom.calls.map((c) => c.method)).toEqual(['DELETE']);
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'deleted' });
    expect(await urlOf(id)).toBe(SUPPLIED);
    expect(await events(id)).toEqual(['meeting_created', 'meeting_updated', 'meeting_created', 'meeting_deleted']);
  });

  it('ignores a job for an older version', async () => {
    const id = await book();
    await change(id, "start_at=start_at+interval '1 hour', end_at=end_at+interval '1 hour'");
    await handleMeetingSyncJob(accountA, { appointmentId: id, version: 1 }, meta);
    expect(zoom.calls).toEqual([]);
    expect(await meetingOf(id)).toBeUndefined();
  });

  it('deletes the meeting when a cancel lands while its create is in flight', async () => {
    const id = await book();
    let reached!: () => void;
    let release!: () => void;
    const atPost = new Promise<void>((r) => { reached = r; });
    zoom.paused = { reached: () => reached(), release: new Promise<void>((r) => { release = r; }) };
    zoom.createMode = 'pause';
    const first = run(id);
    await atPost;
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'creating' });
    await change(id, "status='cancelled', cancel_reason='staff'");
    // The cancel job finds the claim and backs off instead of reconciling.
    await expect(run(id)).rejects.toBeInstanceOf(MeetingSyncRetry);
    release();
    await first;
    zoom.paused = null;
    const m = await meetingOf(id);
    expect(m.sync_state).toBe('deleted');
    expect(zoom.meetings.has(Number(m.external_meeting_id))).toBe(false);
    expect(posts()).toBe(1);
    await run(id);
    expect(posts()).toBe(1);
  });

  it('re-queues stale and ambiguous meetings from the sweep without calling Zoom', async () => {
    const id = await book();
    await run(id);
    await q('UPDATE appointments SET version=version+1 WHERE id=$1', [id]);
    zoom.calls = [];
    const swept = await sweepMeetings(accountA);
    expect(swept.requeued).toBeGreaterThanOrEqual(1);
    expect(await q('SELECT status FROM jobs WHERE dedupe_key=$1', [`appt-mtg:${id}:sweep`])).toEqual([{ status: 'pending' }]);
    expect(zoom.calls).toEqual([]);
  });

  it('refreshes a token once for concurrent requests and marks invalid_grant', async () => {
    await q("UPDATE meeting_connections SET token_expires_at=now()-interval '1 minute' WHERE id=$1", [ids.conn]);
    const before = zoom.refreshes;
    const [a, b] = await Promise.all([getZoomAccessToken(accountA, ids.conn), getZoomAccessToken(accountA, ids.conn)]);
    expect(zoom.refreshes - before).toBe(1);
    expect(a).toBe(b);
    expect(apiCalls()).toBe(0);

    await q("UPDATE meeting_connections SET token_expires_at=now()-interval '1 minute' WHERE id=$1", [ids.conn]);
    zoom.refreshMode = 'invalid';
    await expect(getZoomAccessToken(accountA, ids.conn)).rejects.toMatchObject({ code: 'auth' });
    expect(await q('SELECT status, last_error_code FROM meeting_connections WHERE id=$1', [ids.conn]))
      .toEqual([{ status: 'token_invalid', last_error_code: 'invalid_grant' }]);
    // A token_invalid connection is not called: jobs wait for a reconnect.
    const id = await book();
    zoom.calls = [];
    await run(id);
    expect(zoom.calls).toEqual([]);
    await q("UPDATE meeting_connections SET status='active', last_error_code=NULL, token_expires_at=now()+interval '1 hour' WHERE id=$1", [ids.conn]);
  });

  it('renews a refused cached token once and carries on; a refused renewed token marks the connection', async () => {
    const connStatus = async () => q('SELECT status, last_error_code FROM meeting_connections WHERE id=$1', [ids.conn]);
    await q("UPDATE meeting_connections SET access_token_enc=$2, token_expires_at=now()+interval '1 hour' WHERE id=$1",
      [ids.conn, encrypt('access-stale')]);
    zoom.refused = new Set(['access-stale']);
    const before = zoom.refreshes;
    const id = await book();
    await run(id);
    expect(zoom.refreshes - before).toBe(1);
    // The refused POST (no meeting made) and its one repeat with the renewed token.
    expect(posts()).toBe(2);
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'active', claim_token: null });
    expect(await connStatus()).toEqual([{ status: 'active', last_error_code: null }]);

    // Every token refused: one renewal, then token_invalid; the create was not sent and is retried after a reconnect.
    zoom.refused = new Set(['*']);
    zoom.calls = [];
    const id2 = await book();
    await run(id2);
    expect(zoom.refreshes - before).toBe(2);
    expect(await connStatus()).toEqual([{ status: 'token_invalid', last_error_code: 'api_unauthorized' }]);
    expect(await meetingOf(id2)).toMatchObject({ sync_state: 'creating', last_error_code: 'not_sent', claim_token: null });

    // Booked while token_invalid: nothing queued; the sweep backfills it once the connection is active again.
    zoom.refused = new Set();
    const id3 = await book();
    expect(await enqueue(id3)).toBe(false);
    await q("UPDATE meeting_connections SET status='active', last_error_code=NULL WHERE id=$1", [ids.conn]);
    zoom.calls = [];
    await sweepMeetings(accountA);
    expect(zoom.calls).toEqual([]);
    expect(await q('SELECT status, payload FROM jobs WHERE dedupe_key=$1', [`appt-mtg:${id3}:backfill`]))
      .toEqual([{ status: 'pending', payload: { appointmentId: id3, version: 1 } }]);
    expect(await q('SELECT status FROM jobs WHERE dedupe_key=$1', [`appt-mtg:${id2}:sweep`])).toEqual([{ status: 'pending' }]);
    await run(id3);
    await run(id2);
    expect(await meetingOf(id3)).toMatchObject({ sync_state: 'active' });
    expect(await meetingOf(id2)).toMatchObject({ sync_state: 'active' });
  });

  it('never lets a stale 401 invalidate a connection whose token was replaced', async () => {
    expect(await markZoomTokenRejected(accountA, ids.conn, 'access-from-before-the-reconnect')).toBe(false);
    expect(await q('SELECT status FROM meeting_connections WHERE id=$1', [ids.conn])).toEqual([{ status: 'active' }]);
  });

  it('connects a workspace once per Zoom account, with PKCE and a session-bound state', async () => {
    const actorB = { accountId: accountB, userId: ownerB, role: 'owner' as const };
    const start = await startZoomConnect(actorB);
    const authorize = new URL(start.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = readZoomState('test-only-secret', start.cookie)!;
    expect(authorize.searchParams.get('code_challenge')).toBe(pkceChallenge(state.verifier));
    const nonce = authorize.searchParams.get('state')!;
    // Another admin's session, a wrong nonce or a tampered cookie never reach Zoom.
    zoom.calls = [];
    for (const [actor, input] of [
      [{ ...actorB, userId: ownerA }, { code: 'c1', state: nonce, cookie: start.cookie }],
      [actorB, { code: 'c1', state: 'x'.repeat(32), cookie: start.cookie }],
      [actorB, { code: 'c1', state: nonce, cookie: `${start.cookie}x` }],
    ] as const) await expect(finishZoomConnect(actor, input)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(zoom.calls).toEqual([]);
    // A's Zoom account is live in workspace A: refused, and the grant is never revoked (that would uninstall A's app).
    zoom.meAccount = zoomAccount;
    await expect(finishZoomConnect(actorB, { code: 'c1', state: nonce, cookie: start.cookie })).rejects.toMatchObject({ code: 'zoom_account_in_use' });
    expect(zoom.lastExchange?.get('code_verifier')).toBe(state.verifier);
    expect(zoom.calls.some((c) => c.path === '/oauth/revoke')).toBe(false);
    expect(await q("SELECT status FROM meeting_connections WHERE id=$1", [ids.conn])).toEqual([{ status: 'active' }]);
    zoom.meAccount = `zb${randomUUID().slice(0, 8)}`;
    const dto = await finishZoomConnect(actorB, { code: 'c2', state: nonce, cookie: start.cookie });
    expect(dto).toEqual({ available: true, connected: true, status: 'active', register_attendees: false, last_error_code: null,
      connected_at: expect.any(String) });
    expect(await getMeetingConnection(actorB)).toEqual(dto);
    const [row] = await q<{ access_token_enc: string; zoom_account_id: string }>(
      "SELECT access_token_enc, zoom_account_id FROM meeting_connections WHERE account_id=$1 AND status='active'", [accountB]);
    expect(row.zoom_account_id).toBe(zoom.meAccount);
    expect(row.access_token_enc).not.toContain('access-new');
    expect(await q("SELECT action FROM audit_logs WHERE account_id=$1 AND action LIKE 'integrations.zoom%'", [accountB]))
      .toEqual([{ action: 'integrations.zoom_connect' }]);
    // Without the deployment config the workspace reads as not connected and nothing can start.
    delete process.env.ZOOM_ENABLED;
    try {
      expect(await getMeetingConnection(actorB)).toMatchObject({ available: false, connected: false });
      await expect(startZoomConnect(actorB)).rejects.toMatchObject({ code: 'not_configured' });
    } finally {
      process.env.ZOOM_ENABLED = 'true';
    }
    await disconnectZoom(accountB, ownerB, 'admin');
  });

  it('detaches live meetings on disconnect and calls nothing for them afterwards', async () => {
    const id = await book();
    await run(id);
    await disconnectZoom(accountA, ownerA, 'admin');
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'detached' });
    expect(await q('SELECT status, access_token_enc, refresh_token_enc FROM meeting_connections WHERE id=$1', [ids.conn]))
      .toEqual([{ status: 'disconnected', access_token_enc: null, refresh_token_enc: null }]);
    expect(await q("SELECT action FROM audit_logs WHERE account_id=$1 AND action='integrations.zoom_disconnect'", [accountA])).toHaveLength(1);
    zoom.calls = [];
    await change(id, "start_at=start_at+interval '1 day', end_at=end_at+interval '1 day'");
    expect(await enqueue(id)).toBe(false);
    await run(id);
    expect(zoom.calls).toEqual([]);
    expect(await meetingOf(id)).toMatchObject({ sync_state: 'detached' });
    await expect(recreateMeeting({ accountId: accountA, userId: ownerA, role: 'owner' }, id)).rejects.toBeInstanceOf(MeetingError);
  });
});
