import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataClient } from '@/lib/data/types';

const h = vi.hoisted(() => ({ stored: 0, resolved: 0, templates: 0 }));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async () => { h.stored += 1; return 1; },
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => { h.templates += 1; return { row: { body_text: 'Hi' }, language: 'en_US', malformed: false }; },
}));
vi.mock('@/lib/whatsapp/broadcast-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/broadcast-core')>()),
  resolveApiRecipients: async () => { h.resolved += 1; return { deduped: [], rejected: 0 }; },
}));

import { addApiCampaignRecipients } from './api-campaign';

const A = '11111111-1111-4111-8111-11111111111a';
const CAMPAIGN = { id: 'c-1', account_id: 'acct', kind: 'api', status: 'sent', template_name: 'promo', template_language: 'en_US', whatsapp_config_id: A };

function fakeDb(number: Record<string, unknown>): DataClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const rows = () => (table === 'broadcasts' ? [CAMPAIGN] : table === 'whatsapp_config' ? [number] : [])
        .filter((row: Record<string, unknown>) => Object.entries(filters).every(([k, v]) => row[k] === v));
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (field: string, value: unknown) => { filters[field] = value; return b; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
      };
      return b;
    },
  } as unknown as DataClient;
}

describe('addApiCampaignRecipients on a disconnected number', () => {
  beforeEach(() => { h.stored = 0; h.resolved = 0; h.templates = 0; });

  it('refuses the batch up front with 409 and stores nothing', async () => {
    const disconnected = { id: A, account_id: 'acct', phone_number_id: '1000', access_token: '', status: 'disconnected', is_default: false };
    await expect(addApiCampaignRecipients(fakeDb(disconnected), 'acct', 'u-1', 'c-1', [{ to: '+15551234567' }]))
      .rejects.toMatchObject({ code: 'whatsapp_number_disconnected', status: 409 });
    // No contact resolved (or created), no recipient row, no dispatch job.
    expect(h.resolved).toBe(0);
    expect(h.stored).toBe(0);
    expect(h.templates).toBe(0);
  });

  it('accepts the batch once the number is connected again', async () => {
    const connected = { id: A, account_id: 'acct', phone_number_id: '1000', access_token: 'enc', status: 'connected', is_default: true };
    await expect(addApiCampaignRecipients(fakeDb(connected), 'acct', 'u-1', 'c-1', [{ to: '+15551234567' }]))
      .resolves.toMatchObject({ accepted: 1 });
    expect(h.resolved).toBe(1);
    expect(h.stored).toBe(1);
  });
});
