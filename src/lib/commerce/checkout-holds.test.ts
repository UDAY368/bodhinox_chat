import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The per-contact hold caps at place (review C18) count a contact's open
// orders on every checkout; the partial index keeps that a short range scan.
describe('commerce checkout migration', () => {
  const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261107100500_commerce_checkout/migration.sql'), 'utf8');

  it('indexes a contact\'s orders awaiting payment', () => {
    expect(sql).toMatch(/CREATE INDEX orders_contact_open_idx ON orders \(account_id, contact_id\) WHERE status = 'awaiting_payment';/);
  });
});
