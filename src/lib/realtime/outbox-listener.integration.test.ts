// The LISTEN/NOTIFY wake-up of /api/events against a real PostgreSQL: the trigger notifies
// with the account id only, at commit, and the per-process listener (connected as the
// constrained app role) wakes only that account's streams.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { disconnectDatabases } from '@/lib/db/prisma';
import { cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool } from '@/test/tenancy/fixtures';

const databases = fixtureDatabaseUrls();

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return check();
}
const insert = (account: string) =>
  `INSERT INTO outbox_events(account_id,event_type,payload) VALUES('${account}'::uuid,'contacts.UPDATE','{"secret":"customer text"}'::jsonb)`;

describe.skipIf(!databases)('[SEC-03] outbox NOTIFY wakes only the inserting account', () => {
  let a = '';
  let b = '';
  let listener: typeof import('./outbox-listener');
  let raw: Client;
  const payloads: string[] = [];
  const woke = { a: 0, b: 0 };
  let stopA: () => void;
  let stopB: () => void;

  beforeAll(async () => {
    const pair = await createTenantPair({ label: 'notify' });
    a = pair.a.accountId;
    b = pair.b.accountId;
    process.env.DATABASE_URL = databases!.app;
    listener = await import('./outbox-listener');
    stopA = listener.onOutboxActivity(a, () => woke.a++);
    stopB = listener.onOutboxActivity(b, () => woke.b++);
    raw = new Client({ connectionString: databases!.app });
    raw.on('notification', (m) => {
      if (m.channel === listener.OUTBOX_CHANNEL && m.payload && !m.payload.startsWith('ping:')) payloads.push(m.payload);
    });
    await raw.connect();
    await raw.query(`LISTEN ${listener.OUTBOX_CHANNEL}`);
  }, 60_000);
  afterAll(async () => {
    stopA?.();
    stopB?.();
    await listener?.stopOutboxListener();
    await raw?.end();
    if (a) await cleanupTenants([a, b]);
    await closeFixture();
    await disconnectDatabases();
  }, 60_000);

  it('proves itself healthy with a self-ping', async () => {
    expect(await until(() => listener.outboxListenerHealthy())).toBe(true);
  });

  it('notifies once per account per statement, with the account id only, and wakes only that account', async () => {
    const pool = fixtureOwnerPool();
    const before = { ...woke };
    payloads.length = 0;
    await pool.query(`${insert(a)},('${a}'::uuid,'contacts.UPDATE','{}'::jsonb)`);
    expect(await until(() => woke.a > before.a && payloads.length >= 1)).toBe(true);
    expect(woke.b).toBe(before.b);
    expect(payloads).toEqual([a]);
  });

  it('never notifies for a rolled-back insert', async () => {
    const client = await fixtureOwnerPool().connect();
    const before = { ...woke };
    payloads.length = 0;
    try {
      await client.query('BEGIN');
      await client.query(insert(b));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // A committed marker afterwards proves delivery is flowing, so silence for b is real.
    await fixtureOwnerPool().query(insert(a));
    expect(await until(() => payloads.includes(a))).toBe(true);
    expect(payloads).not.toContain(b);
    expect(woke.b).toBe(before.b);
  });

  it('the app role (as used by the web process) can insert and its commit notifies', async () => {
    const app = new Client({ connectionString: databases!.app });
    await app.connect();
    payloads.length = 0;
    const before = woke.b;
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.account_id',$1,true)`, [b]);
      await app.query(insert(b));
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await app.end();
    }
    expect(await until(() => woke.b > before)).toBe(true);
    expect(payloads).toEqual([b]);
  });

  it('reports unhealthy and wakes streams to poll when stopped', async () => {
    const before = woke.a;
    await listener.stopOutboxListener();
    expect(listener.outboxListenerHealthy()).toBe(false);
    expect(woke.a).toBeGreaterThan(before);
  });
});
