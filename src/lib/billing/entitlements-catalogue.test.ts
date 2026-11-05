import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURES, LIMIT_POLICIES, LIMIT_POLICY, LIMITS, MONTHLY_LIMITS } from './entitlements-catalogue';

const sql = readFileSync(resolve('prisma/migrations/20261112100100_plan_versions/migration.sql'), 'utf8');
const sqlArray = (fn: string) => {
  const body = sql.slice(sql.indexOf(`CREATE FUNCTION ${fn}()`));
  return [...body.slice(0, body.indexOf('$$;')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe('plan catalogue', () => {
  it('matches the keys the database accepts for a published plan version', () => {
    expect(sqlArray('crm_plan_feature_keys')).toEqual([...FEATURES]);
    expect(sqlArray('crm_plan_limit_keys')).toEqual([...LIMITS]);
  });

  it('gives every limit a documented policy', () => {
    for (const key of LIMITS) expect(LIMIT_POLICIES, key).toContain(LIMIT_POLICY[key]);
    expect(Object.keys(LIMIT_POLICY).sort()).toEqual([...LIMITS].sort());
    expect(LIMIT_POLICY.contacts).toBe('hard_inbound_exempt');
    expect(LIMIT_POLICY.messages_monthly).toBe('soft');
    expect(LIMIT_POLICY.monthly_active_contacts).toBe('soft');
    for (const key of MONTHLY_LIMITS) expect(LIMITS).toContain(key);
    const doc = readFileSync(resolve('docs/billing-limits.md'), 'utf8');
    for (const key of LIMITS) expect(doc, key).toContain(`\`${key}\``);
  });
});
