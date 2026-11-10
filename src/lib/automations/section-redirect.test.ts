import { beforeEach, describe, expect, it, vi } from 'vitest';

// Legacy /automations/** URLs land in the right channel section (Stage 1).

const h = vi.hoisted(() => ({
  session: null as null | { accountId: string; userId: string; role: string },
  enabled: ['whatsapp'] as string[],
  row: null as null | { channel: string },
  queries: 0,
  fail: false,
  tenants: [] as unknown[],
}));

vi.mock('@/lib/auth/session', () => ({ resolveSession: async () => h.session }));
vi.mock('@/lib/channels/workspace', () => ({ getWorkspaceChannels: async () => ({ enabled: h.enabled }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (tenant: unknown, op: (tx: unknown) => unknown) => {
    h.tenants.push(tenant);
    if (h.fail) throw new Error('db down');
    return op({ $queryRaw: async () => { h.queries += 1; return h.row ? [h.row] : []; } });
  },
}));

import { legacyAutomationPath, legacyAutomationRedirect } from './section-redirect';

const ID = '00000000-0000-4000-8000-0000000000a9';

beforeEach(() => {
  h.session = { accountId: '00000000-0000-4000-8000-0000000000a1', userId: '00000000-0000-4000-8000-0000000000b1', role: 'agent' };
  h.enabled = ['whatsapp'];
  h.row = null;
  h.queries = 0;
  h.fail = false;
  h.tenants = [];
});

describe('legacyAutomationPath', () => {
  it('sends the list and a new automation to the first enabled channel, WhatsApp first', () => {
    expect(legacyAutomationPath({ kind: 'list' }, ['whatsapp', 'instagram'])).toBe('/whatsapp/automations');
    expect(legacyAutomationPath({ kind: 'list' }, ['instagram'])).toBe('/instagram/automations');
    expect(legacyAutomationPath({ kind: 'new' }, ['instagram'])).toBe('/instagram/automations/new');
  });

  it('keeps a real template slug and drops anything else', () => {
    expect(legacyAutomationPath({ kind: 'new', template: 'welcome_message' }, ['whatsapp']))
      .toBe('/whatsapp/automations/new?template=welcome_message');
    expect(legacyAutomationPath({ kind: 'new', template: 'x"><script>' }, ['whatsapp'])).toBe('/whatsapp/automations/new');
  });

  it('sends an automation to its own channel', () => {
    expect(legacyAutomationPath({ kind: 'edit', id: ID }, ['whatsapp', 'instagram'], 'instagram')).toBe(`/instagram/automations/${ID}/edit`);
    expect(legacyAutomationPath({ kind: 'logs', id: ID }, ['whatsapp'], 'whatsapp')).toBe(`/whatsapp/automations/${ID}/logs`);
    expect(legacyAutomationPath({ kind: 'edit', id: ID }, ['instagram'], null)).toBe(`/instagram/automations/${ID}/edit`);
  });
});

describe('legacyAutomationRedirect', () => {
  it('reads the automation under the caller\'s own tenant', async () => {
    h.enabled = ['whatsapp', 'instagram'];
    h.row = { channel: 'instagram' };
    expect(await legacyAutomationRedirect({ kind: 'edit', id: ID })).toBe(`/instagram/automations/${ID}/edit`);
    expect(h.tenants).toEqual([{ accountId: h.session!.accountId, userId: h.session!.userId, role: 'agent' }]);
  });

  it('never sends a non-UUID id to SQL', async () => {
    expect(await legacyAutomationRedirect({ kind: 'logs', id: 'not-a-uuid' })).toBe('/whatsapp/automations/not-a-uuid/logs');
    expect(h.queries).toBe(0);
  });

  it('falls back to the WhatsApp section without a session or when the read fails', async () => {
    h.session = null;
    expect(await legacyAutomationRedirect({ kind: 'list' })).toBe('/whatsapp/automations');
    h.session = { accountId: 'a', userId: 'u', role: 'agent' };
    h.fail = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await legacyAutomationRedirect({ kind: 'edit', id: ID })).toBe(`/whatsapp/automations/${ID}/edit`);
    error.mockRestore();
  });
});
