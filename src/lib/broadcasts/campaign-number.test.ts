import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { campaignNumberId } from './api-campaign';

const A = '11111111-1111-4111-8111-11111111111a';
const B = '22222222-2222-4222-8222-22222222222b';
const NUMBERS = [
  { id: B, waba_id: 'waba-b', is_default: false, created_at: new Date('2026-02-01') },
  { id: A, waba_id: 'waba-a', is_default: true, created_at: new Date('2026-01-01') },
];

function txWith(rows: unknown[]): TenantTransaction {
  return { $queryRaw: async () => rows } as unknown as TenantTransaction;
}

describe('campaignNumberId (campaign creation picks its sending number)', () => {
  it('uses the default number when none is named', async () => {
    await expect(campaignNumberId(txWith(NUMBERS), 'acct', null, {})).resolves.toBe(A);
  });

  it('uses the named number of this workspace', async () => {
    await expect(campaignNumberId(txWith(NUMBERS), 'acct', B, { waba_id: 'waba-b' })).resolves.toBe(B);
    await expect(campaignNumberId(txWith(NUMBERS), 'acct', B.toUpperCase(), {})).resolves.toBe(B);
  });

  it("refuses a number that is not this workspace's", async () => {
    await expect(campaignNumberId(txWith(NUMBERS), 'acct', '33333333-3333-4333-8333-333333333333', {}))
      .rejects.toMatchObject({ status: 400, code: 'whatsapp_number_unavailable' });
  });

  it("refuses a template from another number's WABA", async () => {
    await expect(campaignNumberId(txWith(NUMBERS), 'acct', B, { waba_id: 'waba-a' }))
      .rejects.toMatchObject({ status: 422, code: 'template_wrong_number' });
  });

  it('asks for a number when several exist and none is the default', async () => {
    await expect(campaignNumberId(txWith(NUMBERS.map((n) => ({ ...n, is_default: false }))), 'acct', null, {}))
      .rejects.toMatchObject({ status: 400, code: 'whatsapp_number_unavailable' });
  });

  it('keeps single-number and not-yet-connected workspaces as before', async () => {
    await expect(campaignNumberId(txWith([{ ...NUMBERS[0], is_default: false, waba_id: null }]), 'acct', null, { waba_id: 'x' })).resolves.toBe(B);
    await expect(campaignNumberId(txWith([]), 'acct', null, {})).resolves.toBeNull();
  });

  it('refuses a named disconnected number with 409 whatsapp_number_disconnected', async () => {
    const rows = [{ ...NUMBERS[0], removed: true }, { ...NUMBERS[1], removed: false }];
    await expect(campaignNumberId(txWith(rows), 'acct', B, {}))
      .rejects.toMatchObject({ status: 409, code: 'whatsapp_number_disconnected' });
  });

  it('never picks a disconnected number as the default or the only number', async () => {
    const rows = [{ ...NUMBERS[0], removed: false }, { ...NUMBERS[1], is_default: false, removed: true }];
    await expect(campaignNumberId(txWith(rows), 'acct', null, {})).resolves.toBe(B);
  });

  it('treats a workspace whose numbers are all disconnected as not connected yet', async () => {
    const rows = NUMBERS.map((n) => ({ ...n, is_default: false, removed: true }));
    await expect(campaignNumberId(txWith(rows), 'acct', null, {})).resolves.toBeNull();
  });
});
