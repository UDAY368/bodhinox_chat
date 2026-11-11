// Stage 5 (5E): contacts channel filter, any/all segments and the new bulk
// actions' validation (the SQL itself runs in bulk-stage5.integration.test.ts).
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tenant: vi.fn() }));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: h.tenant,
}));

import { audienceFilterSchema, compileAudienceFilter } from '@/lib/audience/filter';
import { bulkContactAction, channelFilter, contactChannelStatus, instagramContactStatus, scopeFromQuery } from './bulk';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ctx = { accountId: ACCOUNT, userId: '22222222-2222-4222-8222-222222222222', role: 'agent' as const };
const text = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ');

describe('segments that match any or all conditions', () => {
  const name = { field: 'name', op: 'contains', value: 'a' } as const;
  const email = { field: 'email', op: 'is_empty' } as const;

  it('keeps every earlier filter (no match key) as AND, and accepts match any', () => {
    expect(audienceFilterSchema.safeParse({ conditions: [name] }).success).toBe(true);
    expect(audienceFilterSchema.safeParse({ conditions: [name], match: 'any' }).success).toBe(true);
    expect(audienceFilterSchema.safeParse({ conditions: [name], match: 'some' }).success).toBe(false);
    const all = text(compileAudienceFilter(ACCOUNT, { conditions: [name, email] }));
    expect(all).not.toContain(' OR (');
    expect(all.startsWith('c.account_id=')).toBe(true);
  });

  it('puts any-of conditions in one OR group that stays inside the account scope', () => {
    const any = text(compileAudienceFilter(ACCOUNT, { conditions: [name, email], match: 'any' }));
    expect(any).toBe("c.account_id=?::uuid AND ((c.name ILIKE ?) OR (COALESCE(c.email,'') = ''))");
    // One condition needs no group.
    expect(text(compileAudienceFilter(ACCOUNT, { conditions: [name], match: 'any' }))).not.toContain(' OR ');
  });

  it('compiles the channel conditions', () => {
    expect(text(compileAudienceFilter(ACCOUNT, { conditions: [{ field: 'whatsapp', op: 'has_number' }] }))).toContain("COALESCE(c.phone,'') <> ''");
    expect(text(compileAudienceFilter(ACCOUNT, { conditions: [{ field: 'instagram_subscription', op: 'unsubscribed' }] })))
      .toContain('c.instagram_opted_out_at IS NOT NULL');
    const subscribed = text(compileAudienceFilter(ACCOUNT, { conditions: [{ field: 'instagram_subscription', op: 'subscribed' }] }));
    expect(subscribed).toContain('c.instagram_opted_out_at IS NULL');
    expect(subscribed).toContain("i.channel='instagram'");
  });
});

describe('contacts channel filter', () => {
  it('turns the channel filter and the subscribed switch into conditions', () => {
    expect(channelFilter({})).toEqual({ conditions: [] });
    expect(channelFilter({ channel: 'whatsapp' }).conditions).toEqual([{ field: 'whatsapp', op: 'has_number' }]);
    expect(channelFilter({ channel: 'instagram', subscribedOnly: true }).conditions).toEqual([
      { field: 'instagram', op: 'has_identity' },
      { field: 'instagram_subscription', op: 'subscribed' },
    ]);
  });

  it('reads a scope from the query string', () => {
    expect(scopeFromQuery(new URLSearchParams('tagIds=a,b&channel=instagram&subscribed=1&search=%20'))).toEqual({
      tagIds: ['a', 'b'], channel: 'instagram', subscribedOnly: true,
    });
    expect(scopeFromQuery(new URLSearchParams(''))).toEqual({});
  });

  it('names the Instagram status', () => {
    expect(instagramContactStatus(true, false)).toBe('subscribed');
    expect(instagramContactStatus(true, true)).toBe('unsubscribed');
    expect(instagramContactStatus(false, true)).toBe('unsubscribed');
    expect(instagramContactStatus(false, false)).toBe('none');
  });

  it('asks the database nothing for no valid ids', async () => {
    h.tenant.mockClear();
    expect(await contactChannelStatus(ctx, ['not-a-uuid', ''])).toEqual({});
    expect(h.tenant).not.toHaveBeenCalled();
  });
});

describe('Stage 5 bulk actions', () => {
  const run = (action: unknown, scope: unknown = {}) => bulkContactAction(ctx, { scope, action, expected: 1 });
  const field = '33333333-3333-4333-8333-333333333333';

  it('refuses invalid actions before touching the database', async () => {
    h.tenant.mockClear();
    await expect(run({ type: 'pause_automations', minutes: 45 })).rejects.toThrow('Choose a pause length');
    await expect(run({ type: 'pause_automations' })).rejects.toThrow();
    await expect(run({ type: 'set_field', fieldId: field, value: '   ' })).rejects.toThrow();
    await expect(run({ type: 'set_field', fieldId: field, value: 'x'.repeat(1001) })).rejects.toThrow();
    await expect(run({ type: 'remove_tag', tagId: 'nope' })).rejects.toThrow();
    await expect(run({ type: 'unsubscribe_instagram', extra: true })).rejects.toThrow();
    await expect(run({ type: 'delete' }, { channel: 'sms' })).rejects.toThrow();
    // One view at a time: ticked rows cannot be mixed with a segment.
    await expect(run({ type: 'delete' }, { contactIds: [field], segmentId: field })).rejects.toThrow('Choose one view');
    await expect(run({ type: 'delete' }, { contactIds: Array.from({ length: 101 }, () => field) })).rejects.toThrow();
    expect(h.tenant).not.toHaveBeenCalled();
  });

  it('accepts each pause length, including until resumed', async () => {
    h.tenant.mockReset();
    h.tenant.mockResolvedValue({ matched: 1, changed: 1 });
    for (const minutes of [30, 60, 180, 360, 720, 1440, null])
      await expect(run({ type: 'pause_automations', minutes })).resolves.toEqual({ matched: 1, changed: 1 });
    await expect(run({ type: 'set_field', fieldId: field, value: ' gold ' })).resolves.toEqual({ matched: 1, changed: 1 });
    await expect(run({ type: 'unsubscribe_instagram' }, { channel: 'instagram', subscribedOnly: true })).resolves.toBeDefined();
    await expect(run({ type: 'remove_tag', tagId: field }, { contactIds: [field] })).resolves.toBeDefined();
    expect(h.tenant).toHaveBeenCalledTimes(10);
    expect(h.tenant.mock.calls.every(([tenant]) => tenant === ctx)).toBe(true);
  });
});
