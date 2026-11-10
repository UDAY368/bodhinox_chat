import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ instagramFeature: true }));
vi.mock('@/lib/billing/entitlements', () => ({
  getEntitlements: async () => ({ planId: 'p', planName: 'Plan', features: { instagram: h.instagramFeature }, limits: {} }),
}));

import type { TenantTransaction } from '@/lib/db/tenant';
import {
  assertChannelChange,
  ChannelSettingsError,
  effectiveChannels,
  ensureChannelEnabled,
  getWorkspaceChannels,
  parseChannelChanges,
  readChannelFacts,
  setWorkspaceChannels,
  type ChannelFacts,
} from './workspace';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const facts = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({
  rows: {},
  connections: { whatsapp: 'none', instagram: 'none' },
  instagramPlatform: true,
  instagramPlan: true,
  ...over,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChannelSettingsError) return [error.code, error.status, error.channel];
    throw error;
  }
  return null;
};

/** A transaction double that answers the three fact queries and records every statement. */
function fakeTx(state: { rows?: { channel: string; enabled: boolean }[]; wa?: { usable: number; attention: number };
  ig?: { live: number; attention: number } } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const text = (q: { strings?: readonly string[]; sql?: string }) => q.sql ?? (q.strings ?? []).join('?');
  const tx = {
    $queryRaw: vi.fn(async (q: { sql: string; values: unknown[] }) => {
      const sql = text(q);
      calls.push({ sql, values: q.values });
      if (sql.includes('FROM workspace_channels')) return state.rows ?? [];
      if (sql.includes('FROM whatsapp_config')) return [state.wa ?? { usable: 0, attention: 0 }];
      if (sql.includes('FROM instagram_accounts')) return [state.ig ?? { live: 0, attention: 0 }];
      throw new Error(`unexpected query ${sql}`);
    }),
    $executeRaw: vi.fn(async (q: { sql: string; values: unknown[] }) => {
      calls.push({ sql: text(q), values: q.values });
      if (text(q).includes('INSERT INTO workspace_channels')) {
        const [, channel, value] = q.values as [string, string, boolean | null];
        // ensureChannelEnabled writes a literal true (its third value is the user).
        const enabled = typeof value === 'boolean' ? value : true;
        state.rows = [...(state.rows ?? []).filter((r) => r.channel !== channel), { channel, enabled }];
      }
      return 1;
    }),
  };
  return { tx: tx as unknown as TenantTransaction, calls };
}

beforeEach(() => {
  h.instagramFeature = true;
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
});

describe('effective channel state', () => {
  it('keeps an existing workspace on WhatsApp only, exactly as before Stage 1', () => {
    const state = effectiveChannels(facts({ connections: { whatsapp: 'live', instagram: 'none' } }));
    expect(state.enabled).toEqual(['whatsapp']);
    expect(state.chosen).toBe(false);
    expect(state.channels.whatsapp).toMatchObject({ enabled: true, explicit: false, available: true, state: 'live' });
    expect(state.channels.instagram).toMatchObject({ enabled: false, explicit: false, available: true, state: 'off' });
  });

  it('turns Instagram on by default only while an account is connected', () => {
    expect(effectiveChannels(facts({ connections: { whatsapp: 'live', instagram: 'live' } })).enabled).toEqual(['whatsapp', 'instagram']);
    expect(effectiveChannels(facts({ connections: { whatsapp: 'none', instagram: 'attention' } })).channels.instagram.state).toBe('attention');
  });

  it('follows explicit rows over the defaults', () => {
    const state = effectiveChannels(facts({ rows: { whatsapp: false, instagram: true } }));
    expect(state.enabled).toEqual(['instagram']);
    expect(state.chosen).toBe(true);
    expect(state.channels.whatsapp).toMatchObject({ enabled: false, explicit: true, state: 'off' });
    expect(state.channels.instagram).toMatchObject({ enabled: true, explicit: true, state: 'setup' });
  });

  it('marks Instagram unavailable when the platform or the plan is off, whatever the row says', () => {
    const platform = effectiveChannels(facts({ rows: { instagram: true }, instagramPlatform: false }));
    expect(platform.channels.instagram).toMatchObject({ available: false, unavailableReason: 'platform_off', enabled: false, state: 'unavailable' });
    const plan = effectiveChannels(facts({ rows: { instagram: true }, instagramPlan: false, connections: { whatsapp: 'none', instagram: 'live' } }));
    expect(plan.channels.instagram).toMatchObject({ available: false, unavailableReason: 'plan', enabled: false, state: 'unavailable' });
    expect(plan.enabled).toEqual(['whatsapp']);
    // WhatsApp is always available.
    expect(platform.channels.whatsapp).toMatchObject({ available: true, unavailableReason: null });
  });

  it('shows setup, live and attention for an enabled channel', () => {
    for (const [connection, state] of [['none', 'setup'], ['live', 'live'], ['attention', 'attention']] as const)
      expect(effectiveChannels(facts({ connections: { whatsapp: connection, instagram: 'none' } })).channels.whatsapp.state).toBe(state);
  });
});

describe('reading the facts', () => {
  it('maps rows, number health and Instagram account status into connections', async () => {
    const { tx, calls } = fakeTx({ rows: [{ channel: 'instagram', enabled: true }, { channel: 'bogus', enabled: true }],
      wa: { usable: 2, attention: 1 }, ig: { live: 1, attention: 0 } });
    const read = await readChannelFacts(tx, ACCOUNT, { INSTAGRAM_ENABLED: 'true' });
    expect(read).toEqual({ rows: { instagram: true }, connections: { whatsapp: 'attention', instagram: 'live' }, instagramPlatform: true, instagramPlan: true });
    // Every fact query is scoped to the workspace and never selects a token.
    for (const call of calls) {
      expect(call.sql).toContain('account_id=');
      expect(call.values).toContain(ACCOUNT);
      expect(call.sql).not.toMatch(/SELECT[^;]*access_token\s*(,|AS|FROM)/i);
    }
    expect((await readChannelFacts(fakeTx({ wa: { usable: 1, attention: 0 } }).tx, ACCOUNT, {})).connections)
      .toEqual({ whatsapp: 'live', instagram: 'none' });
  });

  it('reads the platform flag and plan', async () => {
    h.instagramFeature = false;
    const read = await readChannelFacts(fakeTx().tx, ACCOUNT, {});
    expect(read).toMatchObject({ instagramPlatform: false, instagramPlan: false });
  });
});

describe('channel changes', () => {
  it('parses only { channels: { whatsapp?, instagram? } } with booleans', () => {
    expect(parseChannelChanges({ channels: { whatsapp: true, instagram: false } })).toEqual({ whatsapp: true, instagram: false });
    for (const body of [null, [], {}, { channels: {} }, { channels: { whatsapp: 'yes' } }, { channels: { any: true } },
      { channels: { whatsapp: true }, extra: 1 }, { channels: [] }])
      expect(code(() => parseChannelChanges(body))).toEqual(['invalid_request', 400, undefined]);
  });

  it('refuses Instagram without the plan (402) or the platform (503)', () => {
    expect(code(() => assertChannelChange(facts({ instagramPlan: false }), { instagram: true }))).toEqual(['plan_required', 402, 'instagram']);
    expect(code(() => assertChannelChange(facts({ instagramPlatform: false }), { instagram: true }))).toEqual(['platform_off', 503, 'instagram']);
    // Turning it off is always allowed while it is unavailable and not connected.
    expect(code(() => assertChannelChange(facts({ instagramPlan: false }), { instagram: false }))).toBeNull();
  });

  it('refuses to turn off a connected channel (409) so inbound is never dropped', () => {
    expect(code(() => assertChannelChange(facts({ rows: { instagram: true }, connections: { whatsapp: 'live', instagram: 'none' } }), { whatsapp: false })))
      .toEqual(['channel_connected', 409, 'whatsapp']);
    expect(code(() => assertChannelChange(facts({ connections: { whatsapp: 'live', instagram: 'attention' } }), { instagram: false })))
      .toEqual(['channel_connected', 409, 'instagram']);
  });

  it('keeps at least one channel enabled (409)', () => {
    expect(code(() => assertChannelChange(facts(), { whatsapp: false }))).toEqual(['last_channel', 409, undefined]);
    expect(code(() => assertChannelChange(facts(), { whatsapp: false, instagram: false }))).toEqual(['last_channel', 409, undefined]);
    // Instagram that is enabled but unavailable does not count.
    expect(code(() => assertChannelChange(facts({ rows: { instagram: true }, instagramPlan: false }), { whatsapp: false })))
      .toEqual(['last_channel', 409, undefined]);
    expect(code(() => assertChannelChange(facts(), { whatsapp: false, instagram: true }))).toBeNull();
  });
});

describe('writing channel rows', () => {
  it('locks, writes each named channel, audits only real changes and returns the new state', async () => {
    const { tx, calls } = fakeTx({ rows: [{ channel: 'whatsapp', enabled: true }] });
    const state = await setWorkspaceChannels(tx, { accountId: ACCOUNT, userId: USER }, { whatsapp: true, instagram: true });
    expect(state.enabled).toEqual(['whatsapp', 'instagram']);
    const statements = calls.map((c) => c.sql);
    expect(statements.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBe(0);
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO workspace_channels'));
    expect(inserts.map((c) => c.values.slice(0, 3))).toEqual([[ACCOUNT, 'whatsapp', true], [ACCOUNT, 'instagram', true]]);
    for (const insert of inserts) expect(insert.values).toContain(USER);
    const audit = calls.filter((c) => c.sql.includes('INSERT INTO audit_logs'));
    expect(audit).toHaveLength(1);
    expect(audit[0].sql).toContain("'channels.updated'");
    expect(audit[0].values).toContain(JSON.stringify({ instagram: true }));
  });

  it('writes nothing when a rule fails', async () => {
    const { tx, calls } = fakeTx({ wa: { usable: 1, attention: 0 } });
    await expect(setWorkspaceChannels(tx, { accountId: ACCOUNT, userId: USER }, { whatsapp: false })).rejects.toMatchObject({ code: 'channel_connected' });
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('skips the audit row when nothing changed', async () => {
    const { tx, calls } = fakeTx({ rows: [{ channel: 'whatsapp', enabled: true }] });
    await setWorkspaceChannels(tx, { accountId: ACCOUNT, userId: USER }, { whatsapp: true });
    expect(calls.some((c) => c.sql.includes('audit_logs'))).toBe(false);
  });

  it('turns a channel on for a connect path without a user', async () => {
    const { tx, calls } = fakeTx({ rows: [{ channel: 'instagram', enabled: false }] });
    await ensureChannelEnabled(tx, ACCOUNT, 'instagram');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO workspace_channels'))!;
    expect(insert.values).toEqual([ACCOUNT, 'instagram', null]);
    expect(insert.sql).toContain('WHERE NOT workspace_channels.enabled');
    expect((await getWorkspaceChannels(tx, ACCOUNT)).channels.instagram.enabled).toBe(true);
  });
});
