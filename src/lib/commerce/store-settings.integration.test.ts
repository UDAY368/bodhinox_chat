import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { createShippingRate, deleteShippingRate, getStoreSettings, parseStoreSettings, saveStoreSettings } from './store-settings';

// Review C3 on PostgreSQL: shipping-rate fees and coupon amounts are minor units of the store currency, so they
// lock the currency just as a priced variant does (INR 49.00 must never become JPY 4,900).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), owner = randomUUID();
const ctx = { accountId: A, userId: owner, role: 'owner' as const };
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const settings = (currency: string) => parseStoreSettings({ currency, prices_include_tax: true, default_tax_rate_bps: null, reservation_minutes: 30,
  checkout_enabled: false, low_stock_default: 5, legal_name: null, gstin: null, address: null, state_code: null, document_prefix: 'INV',
  storefront_title: null, return_window_days: 7, checkout_template_name: null, checkout_template_language: null });

describe.skipIf(!ownerUrl || !appUrl)('store currency lock on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Store','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Store A',$2)", [A, owner]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [A, owner]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=$1', [A]);
      await q('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('locks the currency while a shipping rate exists', async () => {
    await saveStoreSettings(ctx, settings('INR'));
    expect((await getStoreSettings(ctx)).currency_locked).toBe(false);
    const rate = await createShippingRate(ctx, { name: 'Standard', country: 'IN', postal_prefixes: [], min_subtotal_minor: 0,
      max_subtotal_minor: null, fee_minor: 4900, tax_rate_bps: null, active: true, position: 0 });
    expect((await getStoreSettings(ctx)).currency_locked).toBe(true);
    await expect(saveStoreSettings(ctx, settings('JPY'))).rejects.toMatchObject({ code: 'currency_locked' });
    await deleteShippingRate(ctx, rate.id);
    expect((await saveStoreSettings(ctx, settings('JPY'))).currency).toBe('JPY');
    await saveStoreSettings(ctx, settings('INR'));
  });

  it('locks it for a fixed coupon or a coupon minimum, not for a plain percent coupon', async () => {
    await q("INSERT INTO coupons(account_id,code,kind,value) VALUES($1,'TENPC','percent',1000)", [A]);
    expect((await getStoreSettings(ctx)).currency_locked).toBe(false);
    await q("INSERT INTO coupons(account_id,code,kind,value,min_subtotal_minor) VALUES($1,'MIN','percent',1000,50000)", [A]);
    await expect(saveStoreSettings(ctx, settings('KWD'))).rejects.toMatchObject({ code: 'currency_locked' });
    await q("DELETE FROM coupons WHERE account_id=$1 AND code='MIN'", [A]);
    await q("INSERT INTO coupons(account_id,code,kind,value) VALUES($1,'FLAT500','fixed',50000)", [A]);
    await expect(saveStoreSettings(ctx, settings('KWD'))).rejects.toMatchObject({ code: 'currency_locked' });
    expect((await getStoreSettings(ctx)).currency).toBe('INR');
  });
});
