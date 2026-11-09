import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';

const h = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('./usage-notices', () => ({ notifyLimitRefused: h.notify }));

import { PlanLimitError } from './entitlements';
import { LIMIT_POLICY, LIMITS } from './entitlements-catalogue';
import { gateLimit, gateWithinLimit, requireCampaignSendRoom, requireContactRoom, requireIntegrationRoom, requireSeatRoom, requireStorageRoom,
  requireWhatsAppNumberRoom } from './limits';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

/** A transaction whose plan row has `limits`; counts answer `count`. Records every statement. */
function fakeTx(limits: Record<string, unknown>, count = 0) {
  const statements: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join('?');
      statements.push(text);
      if (text.includes('FROM plans')) return [{ id: 'basic', name: 'Basic', features: {}, limits, version_id: null, version: null, addons: {} }];
      return [{ n: count }];
    }),
    $executeRaw: vi.fn(async (sql: TemplateStringsArray) => { statements.push(sql.join('?')); return 1; }),
  } as unknown as TenantTransaction;
  return { tx, statements };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

beforeEach(() => h.notify.mockReset().mockResolvedValue(undefined));

describe('LIMIT_POLICY coverage', () => {
  it('every limit that is not soft is enforced by a gate somewhere in the server code', () => {
    const gates = /(requireRoomFor|requireWithinLimit|gateLimit|gateWithinLimit|limitMessage)\([^;]*?'([a-z_]+)'/g;
    const gated = new Set<string>();
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(gates)) gated.add(match[2]);
    }
    const missing = LIMITS.filter((key) => LIMIT_POLICY[key] !== 'soft' && !gated.has(key));
    expect(missing).toEqual([]);
    // No limit is display-only any more: the monthly message and active-contact limits gate campaign sends.
    expect(LIMITS.filter((key) => LIMIT_POLICY[key] === 'soft')).toEqual([]);
  });
});

describe('count gates', () => {
  it('take no advisory lock and count nothing when the limit is unlimited (the hot path stays flat)', async () => {
    const { tx, statements } = fakeTx({});
    await requireSeatRoom(tx, ACCOUNT);
    await requireContactRoom(tx, ACCOUNT, 500);
    await requireIntegrationRoom(tx, ACCOUNT);
    expect(statements.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(statements.every((s) => s.includes('FROM plans'))).toBe(true);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('lock, then count, then refuse past a finite limit, recording the 100% notice', async () => {
    const { tx, statements } = fakeTx({ seats: 3, contacts: 100, integrations: 2 }, 3);
    await expect(requireSeatRoom(tx, ACCOUNT)).rejects.toBeInstanceOf(PlanLimitError);
    const lock = statements.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(lock).toBeGreaterThan(0);
    expect(statements.slice(lock + 1).some((s) => s.includes('account_invitations'))).toBe(true);
    expect(h.notify).toHaveBeenCalledWith(ACCOUNT, 'seats');

    // A batch import counts every new row it adds.
    await requireContactRoom(tx, ACCOUNT, 97);
    await expect(requireContactRoom(tx, ACCOUNT, 98)).rejects.toThrow(/up to 100 contacts/);
    await expect(requireIntegrationRoom(tx, ACCOUNT)).rejects.toThrow(/connected integrations/);
  });

  it('passes other errors through without a notice', async () => {
    const { tx } = fakeTx({ lists: 1 });
    await expect(gateLimit(tx, ACCOUNT, 'lists', async () => { throw new Error('db'); })).rejects.toThrow('db');
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('refusal notices on every count gate (Phase 14 review F4)', () => {
  it('WhatsApp numbers, active flows and storage record the 100% notice when they refuse', async () => {
    const { tx } = fakeTx({ whatsapp_numbers: 1, active_flows: 2, storage_bytes: 100 }, 1);
    await expect(requireWhatsAppNumberRoom(tx, ACCOUNT)).rejects.toBeInstanceOf(PlanLimitError);
    expect(h.notify).toHaveBeenLastCalledWith(ACCOUNT, 'whatsapp_numbers');
    await expect(gateWithinLimit(tx, ACCOUNT, 'active_flows', 3)).rejects.toBeInstanceOf(PlanLimitError);
    expect(h.notify).toHaveBeenLastCalledWith(ACCOUNT, 'active_flows');
    const storage = fakeTx({ storage_bytes: 100 }).tx;
    (storage.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join('?').includes('FROM plans') ? [{ id: 'basic', name: 'Basic', features: {}, limits: { storage_bytes: 100 }, version_id: null, version: null, addons: {} }] : [{ bytes: BigInt(90) }]);
    await expect(requireStorageRoom(storage, ACCOUNT, 20)).rejects.toBeInstanceOf(PlanLimitError);
    expect(h.notify).toHaveBeenLastCalledWith(ACCOUNT, 'storage_bytes');
  });

  it('records nothing when the gate passes', async () => {
    const { tx } = fakeTx({ active_flows: 5 });
    await gateWithinLimit(tx, ACCOUNT, 'active_flows', 3);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('lists, segments, staff and Instagram go through the notifying gate, not bare requireRoomFor', () => {
    for (const file of ['src/lib/audience/lists.ts', 'src/lib/audience/segments.ts', 'src/lib/appointments/config.ts', 'src/lib/instagram/connection.ts',
      'src/lib/flows/versions.ts', 'src/app/api/flows/[id]/route.ts']) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      expect(text, file).not.toMatch(/requireRoomFor\(|requireWithinLimit\(/);
    }
  });
});

describe('campaign send gate: messages_monthly and monthly_active_contacts (audit finding 41)', () => {
  it('does nothing for an unlimited plan or an empty campaign', async () => {
    const { tx, statements } = fakeTx({});
    await requireCampaignSendRoom(tx, ACCOUNT, 5000);
    expect(statements.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
    const limited = fakeTx({ messages_monthly: 1 }, 50);
    await requireCampaignSendRoom(limited.tx, ACCOUNT, 0);
    expect(limited.statements).toEqual([]);
  });

  it('counts sent and still-queued campaign messages this month and refuses a campaign that would pass the limit', async () => {
    const { tx, statements } = fakeTx({ messages_monthly: 100 }, 95);
    await requireCampaignSendRoom(tx, ACCOUNT, 5);
    const counted = statements.find((s) => s.includes('broadcast_recipients'));
    expect(counted).toContain("sender_type IN ('agent','bot')");
    expect(counted).toContain("r.status='pending'");
    await expect(requireCampaignSendRoom(tx, ACCOUNT, 6)).rejects.toThrow(/allows up to 100 messages this month/);
    expect(h.notify).toHaveBeenCalledWith(ACCOUNT, 'messages_monthly');
  });

  it('refuses once the month has reached the active-contact limit', async () => {
    const under = fakeTx({ monthly_active_contacts: 10 }, 9);
    await requireCampaignSendRoom(under.tx, ACCOUNT, 500);
    const at = fakeTx({ monthly_active_contacts: 10 }, 10);
    await expect(requireCampaignSendRoom(at.tx, ACCOUNT, 1)).rejects.toThrow(/allows up to 10 active contacts this month/);
    expect(h.notify).toHaveBeenCalledWith(ACCOUNT, 'monthly_active_contacts');
  });

  it('is called by every path that commits campaign recipients, and never by the manual send route', () => {
    for (const file of ['src/lib/broadcasts/create-campaign.ts', 'src/lib/broadcasts/api-campaign.ts', 'src/lib/whatsapp/broadcast-core.ts',
      'src/lib/jobs/scheduled-audience.ts']) {
      expect(readFileSync(join(process.cwd(), file), 'utf8'), file).toMatch(/requireCampaignSendRoom\(/);
    }
    expect(readFileSync(join(process.cwd(), 'src/app/api/whatsapp/send/route.ts'), 'utf8')).not.toMatch(/requireCampaignSendRoom/);
  });
});
