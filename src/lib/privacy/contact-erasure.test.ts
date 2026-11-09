import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const JOB = '44444444-4444-4444-8444-444444444444';
const url = (bucket: string, key: string) => `/api/media/object?${new URLSearchParams({ bucket, key })}`;

const h = vi.hoisted(() => ({
  contact: [] as { phone: string | null; wa: string | null }[],
  media: [] as { media_url: string }[],
  library: [] as { object_key: string }[],
  numbers: [] as { phone_number_id: string }[],
  sql: [] as { sql: string; values: unknown[] }[],
  removed: [] as string[],
  configured: true,
  contexts: [] as unknown[],
}));

const text = (s: TemplateStringsArray) => s.join('?');
const query = async (s: TemplateStringsArray, ...values: unknown[]) => {
  const q = text(s);
  h.sql.push({ sql: q, values });
  if (/FROM contacts\s+WHERE/.test(q)) return h.contact;
  if (q.includes('FROM messages m')) return h.media;
  if (q.includes('crm_erasure_phone_number_ids()')) return h.numbers;
  if (q.includes('in_library')) return h.library;
  if (q.includes('FROM conversations')) return [{ id: 'conv-1' }];
  return [];
};
const exec = async (s: TemplateStringsArray, ...values: unknown[]) => { h.sql.push({ sql: text(s), values }); return 1; };
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ $queryRaw: query, $executeRaw: exec }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push(ctx);
    return fn({ $queryRaw: query, $executeRaw: exec });
  },
}));
vi.mock('@/lib/storage/server', () => ({
  storageConfigured: () => h.configured,
  removeMedia: async (ctx: { accountId: string }, bucket: string, key: string, worker: boolean) => {
    expect(ctx.accountId).toBe(A);
    expect(worker).toBe(true);
    h.removed.push(`${bucket}:${key}`);
  },
}));

import { ContactErasureError, isErasableInboundMedia, parseMediaUrl, requestContactErasure, runContactErasure, wholeTokenPattern } from './contact-erasure';
import type { Prisma } from '@prisma/client';
type Sql = Prisma.Sql;

beforeEach(() => {
  Object.assign(h, { contact: [{ phone: '919000012345', wa: null }], media: [], library: [], numbers: [{ phone_number_id: 'PN1' }],
    sql: [], removed: [], configured: true, contexts: [] });
});

describe('[SEC-01] contact erasure', () => {
  it('parses private media URLs and only erases this workspace\'s mirrored inbound files', () => {
    const inbound = `account-${A}/inbound/1234-image.jpg`;
    expect(parseMediaUrl(url('chat-media', inbound))).toEqual({ bucket: 'chat-media', key: inbound });
    expect(parseMediaUrl('https://lookaside.fbsbx.com/x')).toBeNull();
    expect(isErasableInboundMedia(A, { bucket: 'chat-media', key: inbound })).toBe(true);
    expect(isErasableInboundMedia(A, { bucket: 'chat-media', key: `account-${A}/1700-brochure.pdf` })).toBe(false);
    expect(isErasableInboundMedia(A, { bucket: 'chat-media', key: `account-${USER}/inbound/x.jpg` })).toBe(false);
    expect(isErasableInboundMedia(A, { bucket: 'flow-media', key: inbound })).toBe(false);
  });

  it('audits and queues the request in one tenant transaction, refusing an unknown contact', async () => {
    const actor = { accountId: A, userId: USER, role: 'admin' as const };
    await requestContactErasure(actor, CONTACT);
    expect(h.contexts).toEqual([actor]);
    const writes = h.sql.filter((s) => s.sql.startsWith('INSERT'));
    expect(writes[0].sql).toContain('INSERT INTO jobs');
    expect(writes[0].values).toEqual(['contact.erase', A, JSON.stringify({ contactId: CONTACT, requestedBy: USER })]);
    expect(writes[1].sql).toContain("'contact.erasure_requested'");
    h.contact = [];
    await expect(requestContactErasure(actor, CONTACT)).rejects.toBeInstanceOf(ContactErasureError);
    await expect(requestContactErasure(actor, 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('is a no-op once the contact is gone', async () => {
    h.contact = [];
    expect(await runContactErasure(A, { contactId: CONTACT }, JOB)).toBeNull();
    expect(h.sql.some((s) => s.sql.includes('DELETE'))).toBe(false);
  });

  it('removes inbound media (not library items), scoped receipts and job payloads, then the rows and the contact', async () => {
    const keep = `account-${A}/inbound/1-kept.jpg`, gone = `account-${A}/inbound/2-photo.jpg`;
    h.media = [{ media_url: url('chat-media', gone) }, { media_url: url('chat-media', keep) }, { media_url: url('chat-media', `account-${A}/9-sent.pdf`) }];
    h.library = [{ object_key: keep }];
    const counts = await runContactErasure(A, { contactId: CONTACT, requestedBy: USER }, JOB);
    expect(h.removed).toEqual([`chat-media:${gone}`]);
    const receipts = h.sql.find((s) => s.sql.includes('DELETE FROM webhook_receipts'))!;
    expect(receipts.sql).toContain("status='processed'");
    expect(receipts.values).toContainEqual(['PN1']);
    expect(receipts.values).toContainEqual(['919000012345']);
    const jobs = h.sql.filter((s) => s.sql.includes('jobs'));
    expect(jobs.every((s) => s.values.includes(A))).toBe(true);
    expect(jobs[0].sql).toContain("status IN ('done','failed')");
    expect(jobs[0].values).toContain(JOB);
    expect(jobs[1].sql).toContain("type='webhook.delivery' AND status='pending'");
    const order = h.sql.map((s) => s.sql).filter((q) => /^(UPDATE|DELETE|INSERT)/.test(q.trim())).map((q) => q.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(order.indexOf('DELETE FROM contacts')).toBeGreaterThan(order.indexOf('UPDATE broadcast_recipients SET'));
    expect(order.indexOf('DELETE FROM outbox_events')).toBeGreaterThan(order.indexOf('DELETE FROM contacts'));
    expect(order.at(-1)).toBe('INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)');
    expect(counts).toMatchObject({ mediaFiles: 1, webhookReceipts: 1, contacts: 1 });
    expect(h.contexts.every((c) => (c as { accountId: string }).accountId === A)).toBe(true);
  });

  it('matches a number only as a whole token, and cancels only pending deliveries naming the contact id', async () => {
    const re = new RegExp(wholeTokenPattern('919000012345'));
    expect(re.test('{"phone":"919000012345"}')).toBe(true);
    expect(re.test('919000012345')).toBe(true);
    expect(re.test('{"phone":"+919000012345"}')).toBe(true);
    // Never inside a longer number, id or timestamp.
    expect(re.test('{"phone":"9190000123456"}')).toBe(false);
    expect(re.test('{"id":"x919000012345"}')).toBe(false);
    expect(new RegExp(wholeTokenPattern('a.b+c')).test('aXb+c')).toBe(false);

    await runContactErasure(A, { contactId: CONTACT }, JOB);
    const jobs = h.sql.filter((s) => s.sql.includes('jobs'));
    const fragment = (q: { values: unknown[] }) => q.values.find((v): v is Sql => typeof v === 'object' && v !== null && 'strings' in v)!;
    // Finished payloads: the contact id or the number as a whole token.
    expect(fragment(jobs[0]).sql).toMatch(/strpos\(payload::text, \?\) > 0 OR payload::text ~ ANY/);
    expect(fragment(jobs[0]).values).toEqual([CONTACT, [wholeTokenPattern('919000012345')]]);
    // Pending deliveries: the contact id only.
    expect(fragment(jobs[1]).sql).toBe('strpos(payload::text, ?) > 0');
    expect(fragment(jobs[1]).values).toEqual([CONTACT]);
  });

  it('matches receipts only on numbers the workspace alone holds', async () => {
    h.numbers = [];
    await runContactErasure(A, { contactId: CONTACT }, JOB);
    expect(h.sql.some((s) => s.sql.includes('crm_erasure_phone_number_ids()'))).toBe(true);
    expect(h.sql.some((s) => s.sql.includes('whatsapp_config'))).toBe(false);
    expect(h.sql.some((s) => s.sql.includes('webhook_receipts'))).toBe(false);
  });

  it('skips receipt matching for a short or missing number and deletes media rows when storage was never configured', async () => {
    h.contact = [{ phone: '123', wa: null }];
    h.configured = false;
    h.media = [{ media_url: url('chat-media', `account-${A}/inbound/3-a.jpg`) }];
    await runContactErasure(A, { contactId: CONTACT }, JOB);
    expect(h.removed).toEqual([]);
    expect(h.sql.some((s) => s.sql.includes('DELETE FROM media_objects'))).toBe(true);
    expect(h.sql.some((s) => s.sql.includes('webhook_receipts'))).toBe(false);
    await expect(runContactErasure(A, { contactId: 'x' })).rejects.toThrow(/Invalid/);
  });
});
