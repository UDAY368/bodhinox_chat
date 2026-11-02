import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { loadSegmentFilter } from './segments';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SEGMENT = '33333333-3333-4333-8333-333333333333';

function fakeTx() {
  const statements: string[] = [];
  const tx = {
    $queryRaw: async (sql: Prisma.Sql) => {
      statements.push(sql.sql);
      return [{ filter: { conditions: [{ field: 'name', op: 'is_not_empty' }] } }];
    },
  } as unknown as TenantTransaction;
  return { tx, statements };
}

describe('loadSegmentFilter', () => {
  it('reads without a row lock so viewers can preview and page segments', async () => {
    const { tx, statements } = fakeTx();
    const filter = await loadSegmentFilter(tx, ACCOUNT, SEGMENT);
    expect(filter.conditions).toHaveLength(1);
    expect(statements[0]).toContain('FROM segments');
    expect(statements[0]).not.toMatch(/FOR\s+(SHARE|UPDATE)/i);
  });

  it('locks the segment only when a write path asks for it', async () => {
    const { tx, statements } = fakeTx();
    await loadSegmentFilter(tx, ACCOUNT, SEGMENT, { lock: true });
    expect(statements[0]).toMatch(/FOR SHARE\s*$/);
  });
});
