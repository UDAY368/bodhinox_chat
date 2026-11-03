import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { mediaObjectUrl } from '@/lib/storage/client';
import {
  addToLibrary,
  findMediaReferences,
  getStorageUsage,
  listLibraryMedia,
  prepareLibraryDelete,
  type MediaListQuery,
} from './media-library';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asAgent2: TenantContext = { accountId: accountA, userId: agent2A, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let conversationA = '';

const app = <T>(context: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(context, op);
const viewer = (c: TenantContext) => ({ userId: c.userId, role: c.role });
const query = (over: Partial<MediaListQuery> = {}): MediaListQuery => ({ kind: null, q: null, cursor: null, limit: 30, ...over });
const key = (name: string, account: string = accountA) => `account-${account}/library/${seed}-${name}`;

async function media(name: string, type: string, uploader: string, opts: { account?: string; inLibrary?: boolean; size?: number; createdAt?: string } = {}) {
  const account: string = opts.account ?? accountA;
  return (await owner.query(
    `INSERT INTO media_objects(account_id,uploaded_by,bucket,object_key,content_type,byte_size,original_name,in_library,created_at)
     VALUES($1,$2,'chat-media',$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now())) RETURNING id`,
    [account, uploader, key(name, account), type, opts.size ?? 100, name, opts.inLibrary ?? true, opts.createdAt ?? null])).rows[0].id as string;
}
const row = async (id: string) => (await owner.query('SELECT in_library, deleted_at FROM media_objects WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl)('media library on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Media test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminA, agentA, agent2A, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Media A',$2),($3,'Media B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, adminA, agentA, agent2A, viewerA, accountB, ownerB]);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [accountA, adminA, `9197${seed}`])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, adminA, contact])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, agent2A, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lists only this workspace library, filters by kind and search, and pages without gaps', async () => {
    const same = '2026-10-01T10:00:00.000001Z';
    const ids = [
      await media('photo-1.png', 'image/png', agentA, { createdAt: same }),
      await media('photo-2.jpg', 'image/jpeg', agentA, { createdAt: '2026-10-01T10:00:00.000002Z' }),
      await media('photo-3.webp', 'image/webp', agent2A, { createdAt: same }),
      await media('clip.mp4', 'video/mp4', agentA),
      await media('menu 100%.pdf', 'application/pdf', adminA),
    ];
    await media('inbound.png', 'image/png', agentA, { inLibrary: false });
    await media('other.png', 'image/png', ownerB, { account: accountB });

    const all = await app(asViewer, (tx) => listLibraryMedia(tx, accountA, query(), viewer(asViewer)));
    expect(all.items.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(all.items.every((i) => !i.can_delete)).toBe(true);
    expect(all.items.find((i) => i.kind === 'document')).toMatchObject({ filename: 'menu 100%.pdf', url: mediaObjectUrl('chat-media', key('menu 100%.pdf')) });

    const seen: string[] = [];
    let cursor: MediaListQuery['cursor'] = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await app(asAgent, (tx) => listLibraryMedia(tx, accountA, query({ kind: 'image', limit: 1, cursor }), viewer(asAgent)));
      seen.push(...result.items.map((i) => i.id));
      if (!result.next_cursor) break;
      const decoded: string[] = Buffer.from(result.next_cursor, 'base64url').toString('utf8').split('|');
      cursor = { createdAt: decoded[0], id: decoded[1] };
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(ids.slice(0, 3)));

    const docs = await app(asAgent, (tx) => listLibraryMedia(tx, accountA, query({ kind: 'document' }), viewer(asAgent)));
    expect(docs.items.map((i) => i.filename)).toEqual(['menu 100%.pdf']);
    const searched = await app(asAgent, (tx) => listLibraryMedia(tx, accountA, query({ q: '100%' }), viewer(asAgent)));
    expect(searched.items.map((i) => i.filename)).toEqual(['menu 100%.pdf']);
    const own = await app(asAgent, (tx) => listLibraryMedia(tx, accountA, query({ kind: 'video' }), viewer(asAgent)));
    expect(own.items[0].can_delete).toBe(true);

    const foreign = await app(asB, (tx) => listLibraryMedia(tx, accountA, query(), viewer(asB)));
    expect(foreign.items).toEqual([]);
  });

  it('marks a stored object as a library item and meters storage per workspace', async () => {
    await owner.query(`INSERT INTO media_objects(account_id,uploaded_by,bucket,object_key,content_type,byte_size)
      VALUES($1,$2,'chat-media',$3,'image/png',4096)`, [accountA, agentA, key('fresh.png')]);
    const item = await app(asAgent, (tx) => addToLibrary(tx, accountA, key('fresh.png'), 'C:\\x\\Fresh.png', viewer(asAgent)));
    expect(item).toMatchObject({ filename: 'Fresh.png', kind: 'image', byte_size: 4096, uploaded_by: agentA, can_delete: true });
    await expect(app(asB, (tx) => addToLibrary(tx, accountA, key('fresh.png'), 'x', viewer(asB)))).rejects.toMatchObject({ status: 404 });

    const usage = await app(asViewer, (tx) => getStorageUsage(tx, accountA));
    const expected = (await owner.query(`SELECT SUM(byte_size)::int AS used, (SUM(byte_size) FILTER (WHERE in_library))::int AS lib,
      COUNT(*) FILTER (WHERE in_library)::int AS n FROM media_objects WHERE account_id=$1 AND deleted_at IS NULL`, [accountA])).rows[0];
    expect(usage).toEqual({ used_bytes: expected.used, library_bytes: expected.lib, library_count: expected.n, limit_bytes: null });
    expect((await app(asB, (tx) => getStorageUsage(tx, accountB))).used_bytes).toBe(100);
  });

  it('finds recent message, template and quick reply references, ignoring old messages and other workspaces', async () => {
    const recent = await media('sent.png', 'image/png', agentA);
    const old = await media('old.png', 'image/png', agentA);
    const tpl = await media('header.png', 'image/png', agentA);
    const qr = await media('qr.png', 'image/png', agentA);
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,media_url,created_at) VALUES
      ($1,$2,'customer','image',$3,now() - interval '2 days'),($1,$2,'customer','image',$4,now() - interval '45 days')`,
      [accountA, conversationA, mediaObjectUrl('chat-media', key('sent.png')), `https://app.example${mediaObjectUrl('chat-media', key('old.png'))}`]);
    await owner.query("INSERT INTO message_templates(account_id,user_id,name,body_text,header_media_url) VALUES($1,$2,$3,'Hi',$4)",
      [accountA, adminA, `media_tpl_${seed}`, mediaObjectUrl('chat-media', key('header.png'))]);
    await owner.query("INSERT INTO quick_replies(account_id,user_id,title,kind,interactive_payload) VALUES($1,$2,'Card','interactive',$3::jsonb)",
      [accountA, adminA, JSON.stringify({ header: { type: 'image', path: key('qr.png') } })]);

    const refs = (k: string) => app(asAgent, (tx) => findMediaReferences(tx, accountA, 'chat-media', k));
    expect(await refs(key('sent.png'))).toEqual(['message']);
    expect(await refs(key('old.png'))).toEqual([]);
    expect(await refs(key('header.png'))).toEqual(['template']);
    expect(await refs(key('qr.png'))).toEqual(['quick_reply']);
    expect(await app(asB, (tx) => findMediaReferences(tx, accountB, 'chat-media', key('sent.png')))).toEqual([]);

    // Referenced media is hidden from the library but keeps its object.
    expect(await app(asAgent, (tx) => prepareLibraryDelete(tx, accountA, recent, viewer(asAgent)))).toEqual({ outcome: 'hidden', references: ['message'], retained: false });
    expect(await row(recent)).toMatchObject({ in_library: false, deleted_at: null });
    expect(await app(asAdmin, (tx) => prepareLibraryDelete(tx, accountA, tpl, viewer(asAdmin)))).toMatchObject({ outcome: 'hidden', references: ['template'] });
    expect(await app(asAdmin, (tx) => prepareLibraryDelete(tx, accountA, qr, viewer(asAdmin)))).toMatchObject({ outcome: 'hidden', references: ['quick_reply'] });

    // Old, unreferenced media is soft-deleted for the caller to remove.
    expect(await app(asAgent, (tx) => prepareLibraryDelete(tx, accountA, old, viewer(asAgent)))).toEqual({ outcome: 'remove', bucket: 'chat-media', objectKey: key('old.png') });
    expect((await row(old)).deleted_at).not.toBeNull();
    await expect(app(asAgent, (tx) => prepareLibraryDelete(tx, accountA, old, viewer(asAgent)))).rejects.toMatchObject({ status: 404 });
  });

  it('keeps a library image that a storefront product still uses', async () => {
    const image = await media('product-shot.png', 'image/png', adminA);
    const product = (await owner.query("INSERT INTO shop_products(account_id,name) VALUES($1,'Herbal oil') RETURNING id", [accountA])).rows[0].id;
    await owner.query('INSERT INTO shop_product_images(account_id,product_id,media_id,position) VALUES($1,$2,$3,0)', [accountA, product, image]);
    const refs = (k: string) => app(asAgent, (tx) => findMediaReferences(tx, accountA, 'chat-media', k));
    expect(await refs(key('product-shot.png'))).toEqual(['product']);
    expect(await app(asB, (tx) => findMediaReferences(tx, accountB, 'chat-media', key('product-shot.png')))).toEqual([]);
    expect(await app(asAdmin, (tx) => prepareLibraryDelete(tx, accountA, image, viewer(asAdmin)))).toEqual({ outcome: 'hidden', references: ['product'], retained: false });
    expect(await row(image)).toMatchObject({ in_library: false, deleted_at: null });
    await owner.query('DELETE FROM shop_products WHERE id=$1', [product]);
  });

  it('keeps the header media of a scheduled campaign until its dispatch job finishes', async () => {
    const header = await media('campaign-header.png', 'image/png', agentA);
    const url = mediaObjectUrl('chat-media', key('campaign-header.png'));
    const broadcast = (await owner.query(`INSERT INTO broadcasts(account_id,user_id,name,template_name,status,scheduled_at)
      VALUES($1,$2,'Launch','launch_tpl','scheduled',now() + interval '1 day') RETURNING id`, [accountA, adminA])).rows[0].id;
    // Shaped like create-campaign: the header URL lives only in the dispatch job payload.
    const job = (await owner.query(`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
      VALUES('broadcast.dispatch',$1,$2::jsonb,$3,now() + interval '1 day') RETURNING id`,
      [accountA, JSON.stringify({ broadcastId: broadcast, scope: 'pending', headerMediaUrl: url }), `broadcast:${broadcast}:initial`])).rows[0].id;
    // Another workspace's job that names the same URL never counts for A, and A's job never counts for B.
    await owner.query(`INSERT INTO jobs(type,tenant_id,payload,status) VALUES('broadcast.dispatch',$1,$2::jsonb,'pending')`,
      [accountB, JSON.stringify({ broadcastId: randomUUID(), headerMediaUrl: mediaObjectUrl('chat-media', key('b-header.png')) })]);

    const refs = (k: string) => app(asAgent, (tx) => findMediaReferences(tx, accountA, 'chat-media', k));
    expect(await refs(key('campaign-header.png'))).toEqual(['campaign']);
    expect(await refs(key('b-header.png'))).toEqual([]);
    expect(await app(asB, (tx) => findMediaReferences(tx, accountB, 'chat-media', key('campaign-header.png')))).toEqual([]);

    // A running dispatch still holds the media; a finished one does not.
    await owner.query("UPDATE jobs SET status='running' WHERE id=$1", [job]);
    expect(await refs(key('campaign-header.png'))).toEqual(['campaign']);
    await owner.query("UPDATE jobs SET status='done' WHERE id=$1", [job]);
    expect(await refs(key('campaign-header.png'))).toEqual([]);
    await owner.query("UPDATE jobs SET status='pending' WHERE id=$1", [job]);

    expect(await app(asAgent, (tx) => prepareLibraryDelete(tx, accountA, header, viewer(asAgent)))).toEqual({ outcome: 'hidden', references: ['campaign'], retained: false });
    expect(await row(header)).toMatchObject({ in_library: false, deleted_at: null });
    await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
  });

  it('keeps media under a retention date and enforces who may delete', async () => {
    const retained = await media('retained.png', 'image/png', agentA);
    await owner.query("UPDATE media_objects SET retain_until=now() + interval '1 day' WHERE id=$1", [retained]);
    expect(await app(asAgent, (tx) => prepareLibraryDelete(tx, accountA, retained, viewer(asAgent)))).toEqual({ outcome: 'hidden', references: [], retained: true });

    const theirs = await media('theirs.png', 'image/png', agentA);
    await expect(app(asAgent2, (tx) => prepareLibraryDelete(tx, accountA, theirs, viewer(asAgent2)))).rejects.toMatchObject({ status: 403 });
    // A viewer's row lock is filtered by the agent+ write policy, so the row is invisible to them.
    await expect(app(asViewer, (tx) => prepareLibraryDelete(tx, accountA, theirs, viewer(asViewer)))).rejects.toMatchObject({ status: 404 });
    await expect(app(asB, (tx) => prepareLibraryDelete(tx, accountA, theirs, viewer(asB)))).rejects.toMatchObject({ status: 404 });
    await expect(app(asAdmin, (tx) => prepareLibraryDelete(tx, accountA, 'not-a-uuid', viewer(asAdmin)))).rejects.toMatchObject({ status: 404 });
    expect(await row(theirs)).toMatchObject({ in_library: true, deleted_at: null });
    expect(await app(asAdmin, (tx) => prepareLibraryDelete(tx, accountA, theirs, viewer(asAdmin)))).toMatchObject({ outcome: 'remove' });
  });
});
