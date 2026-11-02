import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async () => 'job-id'),
  accounts: [] as { account_id: string }[],
  rows: [] as { id?: unknown }[],
  statements: [] as { sql: string; values: unknown[] }[],
  sendMail: vi.fn(async () => undefined),
  close: vi.fn(),
}));
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: h.enqueue }));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({ $queryRaw: async () => h.accounts }),
}));
vi.mock('@/lib/auth/email', () => ({
  authEmailTransport: () => ({ sendMail: h.sendMail, close: h.close }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (tx: unknown) => Promise<unknown>) =>
    op({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.statements.push({ sql: strings.join('?'), values });
        return h.rows;
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.statements.push({ sql: strings.join('?'), values });
        return 1;
      },
    }),
}));

import {
  buildDigestEmails,
  DIGEST_INTERVAL_MS,
  DIGEST_MAX_AGE_MS,
  DIGEST_MAX_ITEMS,
  DigestDeferredError,
  digestDedupeKey,
  isUndelivered,
  NOTIFICATION_DIGEST_JOB,
  resetDigestScheduleForTests,
  scheduleNotificationDigests,
  sendNotificationDigest,
  type DigestEntry,
} from './digest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-11-02T12:00:00Z');
const origin = 'https://app.example.test';

let seq = 0;
const entry = (over: Partial<DigestEntry> = {}): DigestEntry => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  user_id: AGENT,
  title: 'New message in a conversation assigned to you',
  link: '/inbox?c=abc',
  created_at: new Date(now.getTime() - 60_000),
  address: 'agent@example.test',
  read: false,
  wants_email: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [];
  h.rows = [];
  h.statements = [];
  process.env.SMTP_URL = 'smtp://localhost:2525';
  process.env.AUTH_EMAIL_FROM = 'Bodhinox <no-reply@example.test>';
  process.env.APP_URL = origin;
  resetDigestScheduleForTests();
});

describe('buildDigestEmails', () => {
  it('sends one email per member listing titles and absolute links', () => {
    const emails = buildDigestEmails(
      [entry({ title: 'Campaign "Diwali" finished', link: '/broadcasts/b1' }), entry(), entry({ user_id: ADMIN, address: 'admin@example.test' })],
      { origin, now },
    );
    expect(emails).toHaveLength(2);
    const agent = emails.find((e) => e.userId === AGENT)!;
    expect(agent.to).toBe('agent@example.test');
    expect(agent.entryIds).toHaveLength(2);
    expect(agent.subject).toBe('2 new notifications in Bodhinox');
    expect(agent.text).toContain('- Campaign "Diwali" finished\n  https://app.example.test/broadcasts/b1');
    expect(agent.text).toContain('https://app.example.test/inbox?c=abc');
    expect(agent.text).toContain('https://app.example.test/notifications');
    expect(emails.find((e) => e.userId === ADMIN)!.subject).toBe('1 new notification in Bodhinox');
  });

  it('leaves out read entries, events switched off, stale entries and members without an address', () => {
    const emails = buildDigestEmails(
      [
        entry({ read: true }),
        entry({ wants_email: false }),
        entry({ created_at: new Date(now.getTime() - DIGEST_MAX_AGE_MS - 1) }),
        entry({ user_id: ADMIN, address: null }),
        entry({ user_id: ADMIN, address: 'not an address' }),
      ],
      { origin, now },
    );
    expect(emails).toEqual([]);
  });

  it('caps the list and says how many earlier ones were left out', () => {
    const many = Array.from({ length: DIGEST_MAX_ITEMS + 3 }, (_, i) =>
      entry({ title: `Alert ${i}`, created_at: new Date(now.getTime() - (100 - i) * 1000) }));
    const [email] = buildDigestEmails(many, { origin, now });
    expect(email.entryIds).toHaveLength(DIGEST_MAX_ITEMS + 3);
    expect(email.text).not.toContain('- Alert 0\n');
    expect(email.text).toContain(`- Alert ${DIGEST_MAX_ITEMS + 2}`);
    expect(email.text).toContain('...and 3 earlier notifications.');
  });

  it('masks numbers in titles for members whose numbers are masked', () => {
    const emails = buildDigestEmails(
      [entry({ title: 'New chat from +919876543210', mask_phones: true }),
        entry({ user_id: ADMIN, address: 'admin@example.test', title: 'New chat from +919876543210', mask_phones: false })],
      { origin, now },
    );
    expect(emails.find((e) => e.userId === AGENT)!.text).toContain('- New chat from +91 98•••••210');
    expect(emails.find((e) => e.userId === AGENT)!.text).not.toContain('9876543210');
    expect(emails.find((e) => e.userId === ADMIN)!.text).toContain('+919876543210');
  });

  it('keeps every title on one line so it cannot forge extra content', () => {
    const [email] = buildDigestEmails([entry({ title: 'Template "x"\r\nBcc: a@b.c y', link: null })], { origin, now });
    expect(email.text).toContain('- Template "x" Bcc: a@b.c y\n');
  });
});

describe('sendNotificationDigest', () => {
  it('does nothing while SMTP is not configured', async () => {
    delete process.env.SMTP_URL;
    expect(await sendNotificationDigest(ACCOUNT)).toMatchObject({ status: 'unconfigured' });
    expect(h.statements).toEqual([]);
  });

  it('claims the entries before sending, and never reads notification bodies', async () => {
    h.rows = [entry(), entry({ read: true })];
    const order: string[] = [];
    const send = vi.fn(async () => { order.push(`send after ${h.statements.length} statements`); });
    const result = await sendNotificationDigest(ACCOUNT, { send, now });
    expect(result).toEqual({ status: 'done', claimed: 2, sent: 1, deferred: 0 });
    const [select, claim] = h.statements;
    expect(select.sql).toContain('FOR UPDATE OF q SKIP LOCKED');
    expect(select.sql).not.toMatch(/\bbody\b/);
    expect(claim.sql).toContain('UPDATE notification_email_queue SET sent_at=');
    // Both entries are claimed, including the read one that is not emailed.
    expect(claim.values).toContainEqual(h.rows.map((r) => r.id));
    expect(order).toEqual(['send after 2 statements']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.test', subject: '1 new notification in Bodhinox' }));
  });

  it('sends through the SMTP transport from the configured sender and closes it', async () => {
    h.rows = [entry()];
    await sendNotificationDigest(ACCOUNT, { now });
    expect(h.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'Bodhinox <no-reply@example.test>', to: 'agent@example.test' }));
    expect(h.close).toHaveBeenCalled();
  });

  it('releases only an undelivered member and fails the job so it retries', async () => {
    const admin = entry({ user_id: ADMIN, address: 'admin@example.test' });
    h.rows = [entry(), admin];
    const send = vi.fn(async (message: { to: string }) => {
      if (message.to === 'admin@example.test') throw Object.assign(new Error('Invalid login: secret'), { code: 'EAUTH' });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sendNotificationDigest(ACCOUNT, { send, now })).rejects.toBeInstanceOf(DigestDeferredError);
    const release = h.statements.at(-1)!;
    expect(release.sql).toContain('SET sent_at=NULL');
    expect(release.values).toContainEqual([admin.id]);
    // Neither the provider message nor the address is logged.
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/secret|admin@example/);
    errors.mockRestore();
  });

  it('keeps an ambiguous failure claimed instead of risking a second email', async () => {
    h.rows = [entry()];
    const send = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendNotificationDigest(ACCOUNT, { send, now })).toMatchObject({ sent: 0 });
    expect(h.statements.some((s) => s.sql.includes('SET sent_at=NULL'))).toBe(false);
  });

  it('classifies only pre-delivery SMTP errors as undelivered', () => {
    expect(isUndelivered({ code: 'ECONNECTION' })).toBe(true);
    expect(isUndelivered({ code: 'EMESSAGE' })).toBe(false);
    expect(isUndelivered(new Error('x'))).toBe(false);
  });
});

describe('scheduleNotificationDigests', () => {
  it('queues one job per workspace per 30-minute window', async () => {
    h.accounts = [{ account_id: ACCOUNT }];
    const at = now.getTime();
    expect(await scheduleNotificationDigests(at)).toBe(1);
    expect(h.enqueue).toHaveBeenCalledWith(NOTIFICATION_DIGEST_JOB, {}, expect.objectContaining({
      tenantId: ACCOUNT, dedupeKey: digestDedupeKey(ACCOUNT, at), maxAttempts: 3,
    }));
    // Looked again a minute later: throttled.
    expect(await scheduleNotificationDigests(at + 60_000)).toBe(0);
    expect(digestDedupeKey(ACCOUNT, at)).toBe(digestDedupeKey(ACCOUNT, at + 60_000));
    expect(digestDedupeKey(ACCOUNT, at)).not.toBe(digestDedupeKey(ACCOUNT, at + DIGEST_INTERVAL_MS));
  });

  it('schedules nothing without SMTP', async () => {
    delete process.env.AUTH_EMAIL_FROM;
    h.accounts = [{ account_id: ACCOUNT }];
    expect(await scheduleNotificationDigests(now.getTime(), true)).toBe(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
