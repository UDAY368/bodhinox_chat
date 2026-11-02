import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { createNotification, isNotificationLink, NOTIFICATION_TYPE_BY_EVENT } from './notify';

const account = '11111111-1111-4111-8111-111111111111';
const alice = '22222222-2222-4222-8222-222222222222';
const bob = '33333333-3333-4333-8333-333333333333';
const carol = '44444444-4444-4444-8444-444444444444';

type Pref = { user_id: string; in_app: boolean; email: boolean };
function fakeTx(prefs: Pref[], { duplicate = false } = {}) {
  const queries: unknown[][] = [];
  const writes: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(values);
      const ids = values.find(Array.isArray) as string[];
      return prefs.filter((p) => ids.includes(p.user_id));
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      writes.push({ sql, values });
      return duplicate && sql.includes('INSERT INTO notifications(') ? 0 : 1;
    },
  } as unknown as TenantTransaction;
  return { tx, queries, writes };
}

const base = { accountId: account, event: 'mention' as const, title: 'Alice mentioned you', link: '/inbox?c=1' };

describe('createNotification', () => {
  it('inserts in-app rows and email entries according to preferences', async () => {
    const { tx, writes } = fakeTx([
      { user_id: bob, in_app: true, email: true },
      { user_id: carol, in_app: false, email: true },
    ]);
    const result = await createNotification(tx, { ...base, userIds: [bob, carol, bob], actorUserId: alice });
    expect(result).toEqual({ inApp: [bob], emailQueued: [bob, carol] });
    const notices = writes.filter((w) => w.sql.includes('INSERT INTO notifications('));
    expect(notices).toHaveLength(1);
    expect(notices[0].values).toContain('mention');
    const emails = writes.filter((w) => w.sql.includes('notification_email_queue'));
    expect(emails).toHaveLength(2);
    // Bob's email entry points at his notification; Carol's has none.
    expect(emails[0].values[3]).toBe(notices[0].values[0]);
    expect(emails[1].values[3]).toBeNull();
  });

  it('never notifies the actor and skips non-members', async () => {
    const { tx, queries, writes } = fakeTx([{ user_id: bob, in_app: true, email: false }]);
    const result = await createNotification(tx, { ...base, userIds: [alice, bob, carol, 'not-a-uuid'], actorUserId: alice });
    expect(queries[0]).toContainEqual([bob, carol]);
    expect(result.inApp).toEqual([bob]);
    expect(writes).toHaveLength(1);
  });

  it('does not queue email again for a deduplicated notification', async () => {
    const { tx, writes } = fakeTx([{ user_id: bob, in_app: true, email: true }], { duplicate: true });
    const result = await createNotification(tx, { ...base, userIds: [bob], dedupeKey: 'note:1' });
    expect(result).toEqual({ inApp: [], emailQueued: [] });
    expect(writes).toHaveLength(1);
  });

  it('does nothing without recipients', async () => {
    const { tx, queries } = fakeTx([]);
    expect(await createNotification(tx, { ...base, userIds: [] })).toEqual({ inApp: [], emailQueued: [] });
    expect(queries).toHaveLength(0);
  });

  it('maps number quality onto the existing health alert type', () => {
    expect(NOTIFICATION_TYPE_BY_EVENT.number_quality).toBe('whatsapp_number_health');
  });

  it.each([
    [{ link: 'https://evil.example' }, 'Invalid notification link'],
    [{ link: '//evil.example' }, 'Invalid notification link'],
    [{ title: '   ' }, 'Notification title is required'],
    [{ event: 'nope' }, 'Invalid notification event'],
    [{ accountId: 'x' }, 'Invalid notification account'],
    [{ conversationId: 'x' }, 'Invalid notification conversation'],
    [{ dedupeKey: 'k'.repeat(201) }, 'Invalid notification dedupe key'],
  ])('rejects %j', async (patch, message) => {
    const { tx } = fakeTx([]);
    await expect(createNotification(tx, { ...base, userIds: [bob], ...(patch as object) } as never)).rejects.toThrow(message);
  });
});

describe('isNotificationLink', () => {
  it('allows only relative in-app paths', () => {
    expect(isNotificationLink('/inbox')).toBe(true);
    expect(isNotificationLink('/\\evil')).toBe(false);
    expect(isNotificationLink('//evil')).toBe(false);
    expect(isNotificationLink('inbox')).toBe(false);
    expect(isNotificationLink('/' + 'a'.repeat(500))).toBe(false);
  });
});
