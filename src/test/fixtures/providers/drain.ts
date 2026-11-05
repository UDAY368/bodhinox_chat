// Test-only helpers shared by the provider ordering suites (owner: T3).
// Not a test file: vitest only collects *.test.ts.
import type pg from 'pg';
import type { Job } from '@/lib/jobs/queue';

/**
 * Runs the queued jobs of the given types, as the worker would, through the
 * real job dispatcher (handleJob). Scoped to the jobs this suite created (its
 * tenant id, or for tenantless jobs such as billing, Meta Page or Instagram
 * deliveries a payload id the suite owns), so suites sharing one database
 * never take each other's work, which a global claimJob() would. With
 * `concurrent` every job runs at once (the Prisma pool gives real parallel
 * transactions). Loops while a handler queues a follow-up of the same type.
 */
export async function drainJobs(owner: pg.Client, filter: { tenantId?: string; types: string[]; payloadIds?: { key: string; values: string[] } },
  opts: { concurrent?: boolean; rounds?: number } = {}): Promise<number> {
  const { handleJob } = await import('@/lib/jobs/handlers');
  if (!filter.tenantId && !filter.payloadIds) throw new Error('drainJobs needs a tenantId or payloadIds');
  let ran = 0;
  for (let round = 0; round < (opts.rounds ?? 5); round++) {
    const rows = filter.tenantId
      ? (await owner.query<JobRow>(`DELETE FROM jobs WHERE tenant_id=$1::uuid AND type = ANY($2::text[]) AND status='pending' RETURNING ${COLUMNS}`,
        [filter.tenantId, filter.types])).rows
      : (await owner.query<JobRow>(`DELETE FROM jobs WHERE payload->>$3 = ANY($1::text[]) AND type = ANY($2::text[]) AND status='pending' RETURNING ${COLUMNS}`,
        [filter.payloadIds!.values, filter.types, filter.payloadIds!.key])).rows;
    if (!rows.length) break;
    const jobs: Job[] = rows.map((r) => ({ ...r, lease_token: 'test-lease' }));
    ran += jobs.length;
    if (opts.concurrent) await Promise.all(jobs.map((job) => handleJob(job)));
    else for (const job of jobs) await handleJob(job);
  }
  return ran;
}

type JobRow = Omit<Job, 'lease_token'>;
const COLUMNS = 'id::text,type,tenant_id::text,payload,attempts,max_attempts';

/** Every ordering of `items` (n! of them; callers keep n <= 4). */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/** A deterministic shuffle (mulberry32), so a failing order can be replayed from its printed seed. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
