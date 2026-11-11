import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowNodeRow, FlowRunRow } from '@/lib/flows/types';

const mocks = vi.hoisted(() => ({
  dispatchOnce: vi.fn(async (_a: string, _k: string, work: () => Promise<unknown>) => work()),
  sheetsAccessToken: vi.fn(async () => ({ ok: true, token: 'access' }) as const),
}));
vi.mock('@/lib/jobs/dispatch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/jobs/dispatch')>()), dispatchOnce: mocks.dispatchOnce }));
vi.mock('./connection', async (importOriginal) => ({ ...(await importOriginal<typeof import('./connection')>()), sheetsAccessToken: mocks.sheetsAccessToken }));
vi.mock('@/lib/workspace/attributes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace/attributes')>()), workspaceValuesFor: vi.fn(async () => ({})),
}));

import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { executeSheetsNode, fillValue, sheetsConfigProblem } from './node';

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const run = { id: '22222222-2222-4222-8222-222222222222', account_id: '11111111-1111-4111-8111-111111111111', transition_seq: 4,
  vars: { email: 'a@b.example', name: '=cmd()' } } as unknown as FlowRunRow;
const node = (config: Record<string, unknown>) => ({ node_key: 'sheet_1', node_type: 'google_sheets', config }) as unknown as FlowNodeRow;
const insert = { op: 'insert_row', spreadsheet_id: SHEET_ID, sheet: 'Leads', columns: [{ column: 'A', value: '{{vars.email}}' }, { column: 'B', value: '{{vars.name}}' }], next: 'n', failure_next: 'f' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GOOGLE_SHEETS_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('config and values', () => {
  it('names the first problem of a step config', () => {
    expect(sheetsConfigProblem(insert)).toBeNull();
    expect(sheetsConfigProblem({ ...insert, op: 'delete_row' })).toBe('op');
    expect(sheetsConfigProblem({ ...insert, spreadsheet_id: 'x' })).toBe('spreadsheet_id');
    expect(sheetsConfigProblem({ ...insert, columns: [] })).toBe('columns');
    expect(sheetsConfigProblem({ ...insert, op: 'update_row' })).toBe('match');
    expect(sheetsConfigProblem({ ...insert, op: 'get_row', match: { column: 'A', value: 'x' }, var_map: [{ column: 'B', var_key: '1bad' }] })).toBe('var_map');
  });
  it('fills run variables without expanding placeholders inside them', () => {
    expect(fillValue('{{vars.a}}-{{vars.missing}}', { a: '{{vars.b}}', b: 'secret' }, {})).toBe('{{vars.b}}-');
  });
});

describe('executeSheetsNode', () => {
  it('is off without the flag', async () => {
    vi.stubEnv('GOOGLE_SHEETS_ENABLED', 'false');
    expect(await executeSheetsNode(run, node(insert))).toMatchObject({ port: 'failure', reason: 'not_enabled' });
  });
  it('appends one RAW row under the run, step and transition intent', async () => {
    const fetcher = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetcher);
    expect(await executeSheetsNode(run, node(insert))).toEqual({ port: 'next', vars: {} });
    expect(mocks.dispatchOnce).toHaveBeenCalledWith(run.account_id, `sheets:${run.id}:sheet_1:4`, expect.any(Function));
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ majorDimension: 'ROWS', values: [['a@b.example', '=cmd()']] });
  });
  it('an earlier attempt with an unknown outcome is never retried: failure port, sheets_outcome_unknown', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    mocks.dispatchOnce.mockRejectedValueOnce(new UncertainDispatchError());
    expect(await executeSheetsNode(run, node(insert))).toMatchObject({ port: 'failure', reason: 'sheets_outcome_unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('a refused write (4xx) is a certain failure, stored as such', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: { status: 'PERMISSION_DENIED' } })));
    expect(await executeSheetsNode(run, node(insert))).toMatchObject({ port: 'failure', reason: 'sheets_failed' });
  });
  it('get_row maps the matched row to run variables', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { values: [['Email', 'Plan'], ['x@y.example', 'Basic'], ['a@b.example', 'Pro']] })));
    const result = await executeSheetsNode(run, node({ ...insert, op: 'get_row', columns: [], match: { column: 'Email', value: '{{vars.email}}' },
      var_map: [{ column: 'Plan', var_key: 'plan' }] }));
    expect(result).toEqual({ port: 'next', vars: { plan: 'Pro' } });
    expect(mocks.dispatchOnce).not.toHaveBeenCalled();
  });
  it('not connected follows the failure port', async () => {
    mocks.sheetsAccessToken.mockResolvedValueOnce({ ok: false, reason: 'not_connected' } as never);
    expect(await executeSheetsNode(run, node(insert))).toMatchObject({ port: 'failure', reason: 'not_connected' });
  });
});
