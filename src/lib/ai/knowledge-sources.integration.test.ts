import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import type { CrawlFetcher } from './crawler';
import { createAdminClient } from '@/lib/data/admin';
import {
  AI_CRAWL_JOB, createFileSource, createSource, deleteSource, getSource, handleCrawlSourceJob, listSources, queueReindexAllSources, recrawlSource,
} from './knowledge-sources';
import { answerUnanswered, promoteToKnowledge, recordUnanswered } from './unanswered';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const ownerB: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

const page = (title: string, text: string, links = '') =>
  `<html><head><title>${title}</title></head><body><main><p>${text} — enough words for the page to be indexed.</p>${links}</main></body></html>`;
let site: Record<string, string> = {};
const fetcher: CrawlFetcher = async (url) => site[url]
  ? { ok: true, status: 200, contentType: 'text/html', location: null, body: Buffer.from(site[url]) }
  : { ok: true, status: 404, contentType: 'text/html', location: null, body: Buffer.alloc(0) };
const deps = { fetcher, embeddingsKey: { key: 'sk-test', corrupt: false }, ingest: async () => {}, delayMs: 0, sleep: async () => {} };

async function jobsFor(sourceId: string) {
  return (await owner.query("SELECT payload FROM jobs WHERE type=$1 AND payload->>'sourceId'=$2 ORDER BY created_at", [AI_CRAWL_JOB, sourceId])).rows
    .map((r) => r.payload as Record<string, unknown>);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('knowledge sources and the crawl job on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'KB test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'KB A',$2),($3,'KB B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, admin, agent, accountB, outsider]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('adds a source with its job in one transaction, per workspace, admin only', async () => {
    const source = await createSource(adminA, { kind: 'website', url: 'https://shop.example.com/', page_limit: 10 });
    expect(source).toMatchObject({ kind: 'website', status: 'queued', page_limit: 10, pages_indexed: 0 });
    expect(await jobsFor(source.id)).toHaveLength(1);
    expect((await listSources(agentA)).map((s) => s.id)).toContain(source.id);
    expect(await listSources(ownerB)).toEqual([]);
    expect(await getSource(ownerB, source.id)).toBeNull();
    await expect(createSource(agentA, { kind: 'text', title: 'x', content: 'y' })).rejects.toMatchObject({ code: 'forbidden' });
    // RLS refuses an agent's write even without the library's role check.
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_knowledge_sources(kind,title) VALUES('text','x')`)).rejects.toThrow();
    // Another workspace cannot delete it.
    expect(await deleteSource(ownerB, source.id)).toBe(false);
  });

  it('crawls, re-crawls in place and deletes pages that disappeared', async () => {
    const source = await createSource(adminA, { kind: 'website', url: 'https://acme.example.org/' });
    const [first] = await jobsFor(source.id);
    site = {
      'https://acme.example.org/': page('Home', 'Welcome', '<a href="/about">About</a>'),
      'https://acme.example.org/about': page('About', 'About us'),
    };
    await handleCrawlSourceJob(accountA, first, deps);
    let found = await getSource(adminA, source.id);
    expect(found?.source).toMatchObject({ status: 'ready', pages_indexed: 2, error: null });
    const ids = Object.fromEntries(found!.pages.map((p) => [p.source_url, p.id]));

    await recrawlSource(adminA, source.id);
    await expect(recrawlSource(adminA, source.id)).rejects.toMatchObject({ code: 'busy' });
    site = { 'https://acme.example.org/': page('Home', 'Welcome') };
    const second = (await jobsFor(source.id)).at(-1)!;
    await handleCrawlSourceJob(accountA, second, deps);
    found = await getSource(adminA, source.id);
    expect(found?.source).toMatchObject({ status: 'ready', pages_indexed: 1 });
    expect(found?.pages.map((p) => p.source_url)).toEqual(['https://acme.example.org/']);
    // Updated in place on (source, url), not re-inserted.
    expect(found?.pages[0].id).toBe(ids['https://acme.example.org/']);
  });

  it('marks a source failed without an embeddings key', async () => {
    const source = await createFileSource(adminA, { title: 'policy.pdf', text: 'Refunds take five days.' });
    const [job] = await jobsFor(source.id);
    await handleCrawlSourceJob(accountA, job, { ...deps, embeddingsKey: { key: null, corrupt: false } });
    expect((await getSource(adminA, source.id))?.source).toMatchObject({ status: 'failed', error: 'embeddings_key_missing', pages_indexed: 1 });
  });

  it('cascades a source delete to its documents', async () => {
    const source = await createFileSource(adminA, { title: 'notes.txt', text: 'Open 9 to 5.' });
    expect(await deleteSource(adminA, source.id)).toBe(true);
    const left = await owner.query('SELECT count(*)::int AS n FROM ai_knowledge_documents WHERE source_id=$1', [source.id]);
    expect(left.rows[0].n).toBe(0);
    // A queued run for the deleted source does nothing.
    const [job] = await jobsFor(source.id);
    await expect(handleCrawlSourceJob(accountA, job, deps)).resolves.toBeUndefined();
  });

  it('lets the worker role run the job', async () => {
    const rows = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    expect(rows[0].role).toBe('bodhinox_worker');
  });

  it('lets only the current run finish after a stale restart', async () => {
    const source = await createSource(adminA, { kind: 'website', url: 'https://stale.example.org/' });
    site = {
      'https://stale.example.org/': page('Home', 'Welcome', '<a href="/about">About</a>'),
      'https://stale.example.org/about': page('About', 'About us'),
    };
    const [runA] = await jobsFor(source.id);
    // Run A's first slice ends at once and queues its continuation; then the worker stalls.
    await handleCrawlSourceJob(accountA, runA, { ...deps, budgetMs: 0 });
    const continuationA = (await jobsFor(source.id)).find((p) => p.runId === runA.runId && p.step === 1)!;
    expect(continuationA).toBeDefined();
    // An hour later the run counts as stale and an admin restarts it.
    await recrawlSource(adminA, source.id, Date.now() + 60 * 60 * 1000);
    const runB = (await jobsFor(source.id)).find((p) => p.runId !== runA.runId)!;

    // A's continuation now changes nothing and queues nothing.
    const before = (await jobsFor(source.id)).length;
    await handleCrawlSourceJob(accountA, continuationA, deps);
    expect((await getSource(adminA, source.id))?.source).toMatchObject({ status: 'queued', pages_indexed: 0 });
    expect((await getSource(adminA, source.id))?.pages).toEqual([]);
    expect(await jobsFor(source.id)).toHaveLength(before);

    await handleCrawlSourceJob(accountA, runB, deps);
    expect((await getSource(adminA, source.id))?.source).toMatchObject({ status: 'ready', pages_indexed: 2, error: null });
  });

  it('keeps pages whose re-crawl failed transiently and deletes the ones that are gone', async () => {
    const source = await createSource(adminA, { kind: 'website', url: 'https://flaky.example.org/', page_limit: 100 });
    const links = Array.from({ length: 50 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
    site = { 'https://flaky.example.org/': page('Home', 'Welcome', links) };
    for (let i = 0; i < 50; i++) site[`https://flaky.example.org/p${i}`] = page(`P${i}`, `Page number ${i}`);
    await handleCrawlSourceJob(accountA, (await jobsFor(source.id))[0], deps);
    expect((await getSource(adminA, source.id))?.source).toMatchObject({ status: 'ready', pages_indexed: 51 });

    // 30 of 50 pages return 503: nothing is deleted and the source says so.
    const n = (url: string) => Number(/\/p(\d+)$/.exec(url)?.[1] ?? -1);
    const outage: CrawlFetcher = async (url, opts) => n(url) >= 0 && n(url) < 30
      ? { ok: true, status: 503, contentType: 'text/html', location: null, body: Buffer.alloc(0) } : fetcher(url, opts);
    await recrawlSource(adminA, source.id);
    await handleCrawlSourceJob(accountA, (await jobsFor(source.id)).at(-1)!, { ...deps, fetcher: outage });
    expect((await getSource(adminA, source.id))?.source).toMatchObject({ status: 'ready', pages_indexed: 51, error: 'crawl_partial' });

    // One page times out and one is really gone: only the gone one is deleted (the SQL hash matches the crawler's).
    delete site['https://flaky.example.org/p49'];
    site['https://flaky.example.org/'] = page('Home', 'Welcome', links.replace('<a href="/p49">p49</a>', ''));
    const timeout: CrawlFetcher = async (url, opts) => url.endsWith('/p7') ? { ok: false, error: 'timeout' } : fetcher(url, opts);
    await recrawlSource(adminA, source.id);
    await handleCrawlSourceJob(accountA, (await jobsFor(source.id)).at(-1)!, { ...deps, fetcher: timeout });
    const found = await getSource(adminA, source.id);
    const urls = found!.pages.map((p) => p.source_url);
    expect(urls).toContain('https://flaky.example.org/p7');
    expect(urls).not.toContain('https://flaky.example.org/p49');
    expect(found?.source).toMatchObject({ status: 'ready', pages_indexed: 50, error: null });
  });

  it('re-indexes every stored document of a source across slices', async () => {
    const source = await createFileSource(adminA, { title: 'big.txt', text: 'Document zero.' });
    await owner.query(
      "INSERT INTO ai_knowledge_documents(account_id,title,content,source_id,fetched_at) SELECT $1,'part '||g,'Part '||g,$2,now() FROM generate_series(1,60) g",
      [accountA, source.id]);
    let clock = 0;
    const indexed: string[] = [];
    const sliced = { ...deps, now: () => clock, budgetMs: 20, ingest: async (_db: unknown, _a: string, _o: unknown, id: string) => { clock += 1; indexed.push(id); } };
    let job: Record<string, unknown> | undefined = (await jobsFor(source.id))[0];
    for (let slices = 0; job && slices < 10; slices++) {
      const seen = (await jobsFor(source.id)).length;
      await handleCrawlSourceJob(accountA, job, sliced);
      const all = await jobsFor(source.id);
      job = all.length > seen ? all.at(-1) : undefined;
    }
    expect(new Set(indexed).size).toBe(61);
    expect((await getSource(adminA, source.id))?.source).toMatchObject({ status: 'ready', pages_indexed: 61, error: null });
    const unhashed = await owner.query('SELECT count(*)::int AS n FROM ai_knowledge_documents WHERE source_id=$1 AND content_hash IS NULL', [source.id]);
    expect(unhashed.rows[0].n).toBe(0);
  });

  it('does not cancel a queued re-index of learned answers when an admin promotes another answer', async () => {
    const record = (question: string) => withTenant({ accountId: accountA }, (tx) => recordUnanswered(tx, { accountId: accountA, question }), getWorkerPrisma());
    const one = await record('Do you deliver to Pune?');
    const two = await record('Is there parking nearby?');
    await answerUnanswered(agentA, one!.id, { answer: 'Yes, in two days.' });
    await answerUnanswered(agentA, two!.id, { answer: 'Yes, behind the shop.' });
    const db = createAdminClient(adminA);
    const first = await promoteToKnowledge(adminA, one!.id, db, 'Yes, in two days.');
    await owner.query("UPDATE ai_knowledge_sources SET error='embedding_failed', status='failed' WHERE id=$1", [first!.sourceId]);

    await recrawlSource(adminA, first!.sourceId);
    await promoteToKnowledge(adminA, two!.id, db, 'Yes, behind the shop.');
    expect((await getSource(adminA, first!.sourceId))?.source).toMatchObject({ status: 'queued' });

    const indexed: string[] = [];
    await handleCrawlSourceJob(accountA, (await jobsFor(first!.sourceId)).at(-1)!, {
      ...deps, ingest: async (_db: unknown, _a: string, _o: unknown, id: string) => { indexed.push(id); },
    });
    expect(indexed).toHaveLength(2);
    expect((await getSource(adminA, first!.sourceId))?.source).toMatchObject({ status: 'ready', error: null, pages_indexed: 2 });
  });

  it('queues one fenced run per idle source for the legacy reindex', async () => {
    const before = (await listSources(adminA)).filter((s) => s.status !== 'queued' && s.status !== 'crawling').length;
    expect(await queueReindexAllSources(adminA)).toBe(before);
    expect((await listSources(adminA)).every((s) => s.status === 'queued' || s.status === 'crawling')).toBe(true);
    expect(await queueReindexAllSources(adminA)).toBe(0);
    await expect(queueReindexAllSources(agentA)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
