// Stage 5 (5F) folder routes without a database: GET is for every member;
// creating, renaming, deleting a folder and filing a flow need a session, the
// Origin + CSRF proof and the agent role, and run as the caller's own
// workspace. Ids are checked before any database work. Tenancy itself (another
// workspace's folder or flow is 404) is covered by folders.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const FLOW = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({ role: 'agent', signedIn: true, csrf: true, calls: [] as Array<[string, ...unknown[]]> }));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => {
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.csrf) throw new (await import('@/lib/auth/account')).ForbiddenError('Invalid CSRF token');
  },
}));
vi.mock('@/lib/flows/folders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/flows/folders')>();
  const record = (name: string) => async (...args: unknown[]) => { h.calls.push([name, ...args]); return name === 'listFolders' ? [] : { id: FOLDER }; };
  return {
    ...actual,
    listFolders: record('listFolders'),
    createFolder: record('createFolder'),
    renameFolder: record('renameFolder'),
    deleteFolder: record('deleteFolder'),
    moveFlowToFolder: async (...args: unknown[]) => {
      h.calls.push(['moveFlowToFolder', ...args]);
      if (args[2] === '55555555-5555-4555-8555-555555555555') throw new actual.FolderError('wrong_channel');
    },
  };
});

import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';
import { PUT } from '../[id]/folder/route';

const json = (method: string, body: unknown) => new Request('https://app.example.test/api/flows/folders', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const tenant = { accountId: ACCOUNT, userId: USER, role: 'agent' };

beforeEach(() => { h.role = 'agent'; h.signedIn = true; h.csrf = true; h.calls = []; });

describe('GET /api/flows/folders', () => {
  it('lists one channel section for any member, uncached', async () => {
    h.role = 'viewer';
    const res = await GET(new Request('https://app.example.test/api/flows/folders?channel=instagram'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(h.calls).toEqual([['listFolders', { ...tenant, role: 'viewer' }, 'instagram']]);
  });

  it('needs a valid channel and a session', async () => {
    expect((await GET(new Request('https://app.example.test/api/flows/folders?channel=sms'))).status).toBe(400);
    h.signedIn = false;
    expect((await GET(new Request('https://app.example.test/api/flows/folders?channel=whatsapp'))).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe('folder mutations', () => {
  it('creates, renames and deletes as an agent in the caller workspace', async () => {
    expect((await POST(json('POST', { channel: 'whatsapp', name: 'Sales' }))).status).toBe(201);
    expect((await PATCH(json('PATCH', { name: 'Leads' }), params(FOLDER))).status).toBe(200);
    expect((await DELETE(json('DELETE', {}), params(FOLDER))).status).toBe(200);
    expect(h.calls).toEqual([
      ['createFolder', tenant, 'whatsapp', 'Sales'],
      ['renameFolder', tenant, FOLDER, 'Leads'],
      ['deleteFolder', tenant, FOLDER],
    ]);
  });

  it('refuses a viewer, a missing CSRF proof and a signed-out caller before any write', async () => {
    h.role = 'viewer';
    expect((await POST(json('POST', { channel: 'whatsapp', name: 'Sales' }))).status).toBe(403);
    expect((await DELETE(json('DELETE', {}), params(FOLDER))).status).toBe(403);
    h.role = 'agent';
    h.csrf = false;
    expect((await PATCH(json('PATCH', { name: 'Leads' }), params(FOLDER))).status).toBe(403);
    expect((await PUT(json('PUT', { folder_id: FOLDER }), params(FLOW))).status).toBe(403);
    h.csrf = true;
    h.signedIn = false;
    expect((await POST(json('POST', { channel: 'whatsapp', name: 'Sales' }))).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers 404 for a malformed id and 400 for a bad channel without touching the database', async () => {
    const renamed = await PATCH(json('PATCH', { name: 'Leads' }), params('nope'));
    expect(renamed.status).toBe(404);
    expect((await renamed.json()).code).toBe('not_found');
    expect((await POST(json('POST', { channel: 'any', name: 'Sales' }))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});

describe('PUT /api/flows/[id]/folder', () => {
  it('files a flow in a folder or at the top level', async () => {
    expect((await PUT(json('PUT', { folder_id: FOLDER }), params(FLOW))).status).toBe(200);
    expect((await PUT(json('PUT', { folder_id: null }), params(FLOW))).status).toBe(200);
    expect(h.calls).toEqual([['moveFlowToFolder', tenant, FLOW, FOLDER], ['moveFlowToFolder', tenant, FLOW, null]]);
  });

  it('refuses malformed ids and answers a wrong-channel folder with 422', async () => {
    expect((await PUT(json('PUT', { folder_id: 'x' }), params(FLOW))).status).toBe(404);
    expect((await PUT(json('PUT', { folder_id: FOLDER }), params('x'))).status).toBe(404);
    const wrong = await PUT(json('PUT', { folder_id: '55555555-5555-4555-8555-555555555555' }), params(FLOW));
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).code).toBe('wrong_channel');
  });
});
