// Campaigns list send times: broadcasts.started_at / finished_at are added
// (nullable, additive), backfilled before the trigger exists, and kept by a
// BEFORE trigger on status so every writer records them. The inventory and
// the browser contract carry the columns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import checksums from '../../../prisma/migration-checksums.json';
import { resources } from '@/lib/data/contracts';

const NAME = '20261123016500_broadcast_send_times';
const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', NAME, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');

describe('broadcast send times migration', () => {
  it('is recorded and adds two nullable columns', () => {
    expect((checksums as Record<string, string>)[NAME]).toMatch(/^[0-9a-f]{64}$/);
    expect(sql).toMatch(/ADD COLUMN started_at timestamptz,\s*ADD COLUMN finished_at timestamptz;/);
    expect(sql).not.toMatch(/\bDROP\b|NOT NULL/);
  });

  it('backfills before the trigger exists and only for started campaigns', () => {
    expect(sql.indexOf('UPDATE broadcasts')).toBeLessThan(sql.indexOf('CREATE TRIGGER'));
    expect(sql).toContain("WHERE b.status IN ('sending', 'paused', 'sent', 'failed')");
  });

  it('sets started_at on the move to sending and finished_at on sent or failed', () => {
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF status ON broadcasts/);
    expect(sql).toMatch(/NEW\.status = 'sending'[\s\S]*NEW\.started_at := COALESCE\(NEW\.started_at, now\(\)\);\s*NEW\.finished_at := NULL;/);
    expect(sql).toMatch(/NEW\.status IN \('sent', 'failed'\)[\s\S]*NEW\.finished_at := now\(\);/);
  });

  it('lists the columns in the inventory, readable but not writable by the browser contract', () => {
    const names = (inventory.tables as unknown as Record<string, Array<{ name: string }>>).broadcasts.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['started_at', 'finished_at']));
    expect(resources.broadcasts.read).toEqual(expect.arrayContaining(['started_at', 'finished_at']));
  });
});
