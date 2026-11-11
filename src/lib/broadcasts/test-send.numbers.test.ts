/**
 * A campaign test send goes out from the number the campaign will use: the
 * chosen one, else the workspace default; a template from another WABA is
 * refused like the campaign itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const TEMPLATE_ID = '00000000-0000-4000-8000-0000000000c1';

const state = vi.hoisted(() => ({
  numbers: [] as Record<string, unknown>[],
  templateWaba: null as string | null,
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_scope: unknown, operation: (tx: unknown) => Promise<unknown>) => operation({
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM message_templates')) {
        return [{
          id: TEMPLATE_ID, user_id: '00000000-0000-4000-8000-0000000000b1', name: 'promo', category: 'Marketing', language: 'en_US', body_text: 'Hello',
          status: 'APPROVED', buttons: [], created_at: '2026-01-01T00:00:00Z', waba_id: state.templateWaba,
        }];
      }
      if (sql.includes('FROM whatsapp_config')) return state.numbers;
      return [];
    },
  }),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  databaseAdmin: () => ({
    from: () => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (field: string, value: unknown) => ((filters[field] = value), b);
      b.maybeSingle = async () => ({ data: state.numbers.find((row) => row.id === filters.id) ?? null, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (value: string) => `plain:${value}` }));
const meta = vi.hoisted(() => ({ send: vi.fn<(...args: unknown[]) => Promise<{ messageId: string }>>(async () => ({ messageId: 'wamid' })) }));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()), sendTemplateMessage: meta.send }));
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: vi.fn() }));

import { sendCampaignTest } from './test-send';

const SCOPE = { accountId: ACCOUNT, userId: '00000000-0000-4000-8000-0000000000b1', role: 'agent' as const };
const run = (extra: Record<string, unknown> = {}) =>
  sendCampaignTest(SCOPE, { templateId: TEMPLATE_ID, phones: ['+14155550101'], variables: {}, ...extra });
const sentFrom = () => (meta.send.mock.calls[0][0] as { phoneNumberId: string; accessToken: string });

beforeEach(() => {
  meta.send.mockClear();
  state.templateWaba = null;
  state.numbers = [
    { id: A, phone_number_id: 'PN-A', access_token: 'tok-a', waba_id: 'WABA-1', is_default: true, created_at: new Date('2026-01-01') },
    { id: B, phone_number_id: 'PN-B', access_token: 'tok-b', waba_id: 'WABA-2', is_default: false, created_at: new Date('2026-02-01') },
  ];
});

describe('campaign test send with two numbers', () => {
  it('sends from the default number when the campaign names none', async () => {
    await expect(run()).resolves.toEqual([{ phone: '+14155550101', ok: true }]);
    expect(sentFrom()).toEqual(expect.objectContaining({ phoneNumberId: 'PN-A', accessToken: 'plain:tok-a' }));
  });

  it("sends from the campaign's chosen number", async () => {
    await expect(run({ whatsappConfigId: B })).resolves.toEqual([{ phone: '+14155550101', ok: true }]);
    expect(sentFrom()).toEqual(expect.objectContaining({ phoneNumberId: 'PN-B', accessToken: 'plain:tok-b' }));
  });

  it("refuses a template from another WABA than the chosen number's, before sending", async () => {
    state.templateWaba = 'WABA-1';
    await expect(run({ whatsappConfigId: B })).rejects.toMatchObject({ status: 422 });
    expect(meta.send).not.toHaveBeenCalled();
  });

  it('refuses a number outside the workspace and asks for one with no default', async () => {
    await expect(run({ whatsappConfigId: '00000000-0000-4000-8000-0000000000ff' })).rejects.toMatchObject({ status: 400 });
    state.numbers = state.numbers.map((row) => ({ ...row, is_default: false }));
    await expect(run()).rejects.toMatchObject({ status: 400 });
    expect(meta.send).not.toHaveBeenCalled();
  });

  it('keeps the per-number "not connected" result for a workspace with no number', async () => {
    state.numbers = [];
    await expect(run()).resolves.toEqual([{ phone: '+14155550101', ok: false, error: 'WhatsApp is not connected for this workspace' }]);
  });
});
