import { beforeEach, describe, expect, it, vi } from 'vitest';

// Validation runs before any database work: a refused input never opens a transaction.
const h = vi.hoisted(() => ({ withTenant: vi.fn() }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: h.withTenant }));

import { AudienceFilterError } from '@/lib/audience/filter';
import { bulkContactAction } from './bulk';
import { IMPORT_BATCH_SIZE, importContactBatch } from './import';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' as const };
const LIST = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  h.withTenant.mockReset();
  h.withTenant.mockResolvedValue({ ok: true });
});

describe('importContactBatch input', () => {
  it.each([
    ['a national number', { rows: [{ phone: '09876543210' }] }],
    ['a + prefix', { rows: [{ phone: '+919876543210' }] }],
    ['too short', { rows: [{ phone: '1234567' }] }],
    ['an empty batch', { rows: [] }],
    ['an unknown column', { rows: [{ phone: '919876543210', account_id: LIST }] }],
    ['a bad tag id', { rows: [{ phone: '919876543210', tagIds: ['vip'] }] }],
    ['too many rows', { rows: Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) => ({ phone: `91987654${String(i).padStart(4, '0')}` })) }],
    ['no body', null],
  ])('refuses %s', async (_label, input) => {
    await expect(importContactBatch(ctx, input)).rejects.toBeInstanceOf(AudienceFilterError);
    expect(h.withTenant).not.toHaveBeenCalled();
  });

  it('accepts a full batch of digits-only numbers', async () => {
    const rows = Array.from({ length: IMPORT_BATCH_SIZE }, (_, i) => ({ phone: `91987654${String(i).padStart(4, '0')}`, name: "O'Brien" }));
    await expect(importContactBatch(ctx, { rows, updateExisting: true })).resolves.toEqual({ ok: true });
    expect(h.withTenant).toHaveBeenCalledOnce();
  });
});

describe('bulkContactAction input', () => {
  it.each([
    ['two views at once', { scope: { listId: LIST, tagIds: [LIST] }, action: { type: 'delete' }, expected: 3 }],
    ['no expected count', { scope: {}, action: { type: 'delete' } }],
    ['a zero count', { scope: {}, action: { type: 'delete' }, expected: 0 }],
    ['an unknown action', { scope: {}, action: { type: 'block' }, expected: 3 }],
    ['a list action without a list', { scope: {}, action: { type: 'add_to_list' }, expected: 3 }],
    ['a tag that is not an id', { scope: {}, action: { type: 'add_tag', tagId: 'vip' }, expected: 3 }],
    ['raw SQL in the scope', { scope: { where: '1=1' }, action: { type: 'delete' }, expected: 3 }],
  ])('refuses %s', async (_label, input) => {
    await expect(bulkContactAction(ctx, input)).rejects.toBeInstanceOf(AudienceFilterError);
    expect(h.withTenant).not.toHaveBeenCalled();
  });

  it('accepts a view with a search', async () => {
    await expect(bulkContactAction(ctx, { scope: { tagIds: [LIST], search: 'Sharma, Raj' }, action: { type: 'add_tag', tagId: LIST }, expected: 4 }))
      .resolves.toEqual({ ok: true });
  });
});
