import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { DEFAULT_INBOX_FILTERS, MAX_SAVED_FILTERS } from './saved-filters';
import {
  createSavedFilter,
  deleteSavedFilter,
  InboxPreferenceError,
  listQuickReplyFavourites,
  listSavedFilters,
  setQuickReplyFavourite,
  updateSavedFilter,
} from './saved-filters-store';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
let owner: pg.Client;
let quickReplyA = '', quickReplyA2 = '', quickReplyB = '';

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof InboxPreferenceError ? error.status : 'other';
  }
};

describe.skipIf(!ownerUrl || !appUrl)('saved inbox views and favourite quick replies on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Views test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Views A',$2),($3,'Views B',$4)", [accountA, agentA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'agent'),($1,$3,'viewer'),($4,$5,'owner')`,
      [accountA, agentA, viewerA, accountB, ownerB]);
    const qr = async (account: string, user: string, title: string) =>
      (await owner.query('INSERT INTO quick_replies(account_id,user_id,title,content_text) VALUES($1,$2,$3,$3) RETURNING id', [account, user, title])).rows[0].id as string;
    quickReplyA = await qr(accountA, agentA, 'Hi');
    quickReplyA2 = await qr(accountA, agentA, 'Bye');
    quickReplyB = await qr(accountB, ownerB, 'Other');
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[agentA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('keeps each member views private, ordered, editable and deletable only by their owner', async () => {
    const filters = { ...DEFAULT_INBOX_FILTERS, filter: 'unassigned' as const, tagIds: [randomUUID()] };
    const first = await createSavedFilter(asAgent, { name: 'Unassigned', filters });
    const second = await createSavedFilter(asAgent, { name: 'All', filters: DEFAULT_INBOX_FILTERS });
    expect([first.position, second.position]).toEqual([0, 1]);
    expect(first.filters).toEqual(filters);
    const viewerView = await createSavedFilter(asViewer, { name: 'Mine', filters: DEFAULT_INBOX_FILTERS });

    expect((await listSavedFilters(asAgent)).map((v) => v.name)).toEqual(['Unassigned', 'All']);
    expect((await listSavedFilters(asViewer)).map((v) => v.id)).toEqual([viewerView.id]);
    expect(await listSavedFilters(asB)).toEqual([]);

    // Another member, or another workspace, sees a 404 and changes nothing.
    expect(await status(updateSavedFilter(asViewer, first.id, { name: 'Hijack' }))).toBe(404);
    expect(await status(deleteSavedFilter(asB, first.id))).toBe(404);
    expect(await status(updateSavedFilter(asAgent, 'not-a-uuid', { name: 'x' }))).toBe(404);

    const moved = await updateSavedFilter(asAgent, first.id, { name: 'Renamed', position: 5 });
    expect(moved).toMatchObject({ name: 'Renamed', position: 5 });
    expect((await listSavedFilters(asAgent)).map((v) => v.name)).toEqual(['All', 'Renamed']);

    await deleteSavedFilter(asAgent, second.id);
    expect(await status(deleteSavedFilter(asAgent, second.id))).toBe(404);
    expect((await listSavedFilters(asAgent)).map((v) => v.id)).toEqual([first.id]);
  });

  it('refuses raw writes for another member even through the app role', async () => {
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO saved_filters(user_id,name) VALUES(${viewerA}::uuid,'Forged')`)).rejects.toThrow();
    const touched = await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE saved_filters SET name='Forged' WHERE user_id=${viewerA}::uuid`);
    expect(touched).toBe(0);
  });

  it('caps saved views per member', async () => {
    const existing = (await listSavedFilters(asViewer)).length;
    for (let i = existing; i < MAX_SAVED_FILTERS; i += 1)
      await createSavedFilter(asViewer, { name: `View ${i}`, filters: DEFAULT_INBOX_FILTERS });
    expect(await status(createSavedFilter(asViewer, { name: 'One too many', filters: DEFAULT_INBOX_FILTERS }))).toBe(409);
    // The cap is per member: the agent can still save.
    expect(await status(createSavedFilter(asAgent, { name: 'Still fine', filters: DEFAULT_INBOX_FILTERS }))).toBe('ok');
  });

  it('stars quick replies per member, idempotently, inside the workspace only', async () => {
    await setQuickReplyFavourite(asAgent, quickReplyA, true);
    await setQuickReplyFavourite(asAgent, quickReplyA, true);
    await setQuickReplyFavourite(asAgent, quickReplyA2, true);
    expect(new Set(await listQuickReplyFavourites(asAgent))).toEqual(new Set([quickReplyA, quickReplyA2]));
    expect(await listQuickReplyFavourites(asViewer)).toEqual([]);

    expect(await status(setQuickReplyFavourite(asAgent, quickReplyB, true))).toBe(404);
    expect(await status(setQuickReplyFavourite(asAgent, randomUUID(), true))).toBe(404);

    await setQuickReplyFavourite(asAgent, quickReplyA2, false);
    await setQuickReplyFavourite(asAgent, quickReplyA2, false);
    expect(await listQuickReplyFavourites(asAgent)).toEqual([quickReplyA]);

    // Deleting the quick reply removes the favourite with it.
    await owner.query('DELETE FROM quick_replies WHERE id=$1', [quickReplyA]);
    expect(await listQuickReplyFavourites(asAgent)).toEqual([]);
  });
});
