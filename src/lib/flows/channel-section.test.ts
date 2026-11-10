import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@/types';

const h = vi.hoisted(() => ({
  enabled: ['whatsapp'] as Channel[],
  row: null as { channel_scope: string; published_version_id: string | null } | null,
  statements: [] as string[],
}));
vi.mock('@/lib/channels/workspace', () => ({ getWorkspaceChannels: async () => ({ enabled: h.enabled }) }));

import {
  assertFlowChannelOpen, assertScopeChangeAllowed, FlowChannelError, flowChannelErrorResponse, scopeChangeAllowed, scopeOpen,
} from './channel-section';
import type { TenantTransaction } from '@/lib/db/tenant';

const text = (sql: { strings: string[] }) => sql.strings.join('?').replace(/\s+/g, ' ');
const tx = {
  $executeRaw: async (sql: { strings: string[] }) => { h.statements.push(text(sql)); return 1; },
  $queryRaw: async (sql: { strings: string[] }) => { h.statements.push(text(sql)); return h.row ? [h.row] : []; },
} as unknown as TenantTransaction;
const FLOW = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  h.enabled = ['whatsapp'];
  h.row = { channel_scope: 'whatsapp', published_version_id: null };
  h.statements = [];
});

describe('scopeChangeAllowed', () => {
  it('lets a never-published flow move and fixes a published one', () => {
    expect(scopeChangeAllowed('whatsapp', 'instagram', null)).toBe(true);
    expect(scopeChangeAllowed('whatsapp', 'instagram', 'v1')).toBe(false);
    expect(scopeChangeAllowed('any', 'whatsapp', 'v1')).toBe(false);
    expect(scopeChangeAllowed('whatsapp', 'whatsapp', 'v1')).toBe(true);
    // A row read before Phase 11 is WhatsApp.
    expect(scopeChangeAllowed(undefined, 'whatsapp', 'v1')).toBe(true);
  });
});

describe('scopeOpen', () => {
  it("needs the flow's channel on; a legacy 'any' flow needs one of its two", () => {
    expect(scopeOpen('whatsapp', ['whatsapp'])).toBe(true);
    expect(scopeOpen('instagram', ['whatsapp'])).toBe(false);
    expect(scopeOpen('any', ['instagram'])).toBe(true);
    expect(scopeOpen('any', [])).toBe(false);
    expect(scopeOpen(null, ['whatsapp'])).toBe(true);
  });
});

describe('assertScopeChangeAllowed', () => {
  it('locks the flow row in the tenant and refuses a published flow with channel_locked', async () => {
    h.row = { channel_scope: 'whatsapp', published_version_id: 'v1' };
    await expect(assertScopeChangeAllowed(tx, 'account-a', FLOW, 'instagram')).rejects.toMatchObject({ code: 'channel_locked', channel: 'whatsapp' });
    expect(h.statements[0]).toContain('FOR UPDATE');
    expect(h.statements[0]).toContain('account_id=?::uuid AND id=?::uuid');
    await expect(assertScopeChangeAllowed(tx, 'account-a', FLOW, 'whatsapp')).resolves.toBeUndefined();
  });

  it('leaves a missing flow to the save, which answers not_found', async () => {
    h.row = null;
    await expect(assertScopeChangeAllowed(tx, 'account-a', FLOW, 'instagram')).resolves.toBeUndefined();
  });
});

describe('assertFlowChannelOpen', () => {
  it('takes the account publish lock before the flow row lock (publishFlow order)', async () => {
    await assertFlowChannelOpen(tx, 'account-a', FLOW);
    expect(h.statements[0]).toContain('pg_advisory_xact_lock');
    expect(h.statements[1]).toContain('FOR UPDATE');
  });

  it('refuses a flow whose channel is off with channel_disabled, and allows it once on', async () => {
    h.row = { channel_scope: 'instagram', published_version_id: null };
    await expect(assertFlowChannelOpen(tx, 'account-a', FLOW)).rejects.toMatchObject({ code: 'channel_disabled', channel: 'instagram', status: 409 });
    h.enabled = ['whatsapp', 'instagram'];
    await expect(assertFlowChannelOpen(tx, 'account-a', FLOW)).resolves.toBeUndefined();
  });

  it("keeps legacy 'any' flows publishable while either channel is on", async () => {
    h.row = { channel_scope: 'any', published_version_id: 'v1' };
    h.enabled = ['whatsapp'];
    await expect(assertFlowChannelOpen(tx, 'account-a', FLOW)).resolves.toBeUndefined();
  });
});

describe('flowChannelErrorResponse', () => {
  it('answers 409 with a fixed, translated message and the code', async () => {
    const locked = flowChannelErrorResponse(new FlowChannelError('channel_locked', 'whatsapp'))!;
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ code: 'channel_locked', channel: 'whatsapp', error: expect.stringMatching(/Duplicate/) });
    const disabled = flowChannelErrorResponse(new FlowChannelError('channel_disabled', 'instagram'))!;
    expect(await disabled.json()).toMatchObject({ code: 'channel_disabled', error: expect.stringContaining('Instagram') });
    expect(flowChannelErrorResponse(new Error('other'))).toBeNull();
  });
});
