// Runs the queued `whatsapp.webhook` job of each receipt id given on the command
// line, the way the worker would (claim with a lease, handle, finish), and
// nothing else. End-to-end runs have no worker process; specs call this through
// drainWhatsAppReceipts (e2e/journeys.ts). Refuses any database whose name does not
// contain "test", like e2e/global-setup.
import { randomUUID } from 'node:crypto';
import { disconnectDatabases, getWorkerPrisma } from '../src/lib/db/prisma';
import { handleJob } from '../src/lib/jobs/handlers';
import { finishJob, type Job } from '../src/lib/jobs/queue';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rule as e2e/global-setup testDatabase(): the connected database's own name must contain "test"
 * (checked on the worker connection itself, so it holds for the local and the remote .env.test database). */
async function assertTestDatabase() {
  if (!process.env.WORKER_DATABASE_URL) throw new Error('drain-whatsapp: WORKER_DATABASE_URL is required');
  const rows = await getWorkerPrisma().$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (!/test/i.test(rows[0]?.name ?? '')) throw new Error('drain-whatsapp: WORKER_DATABASE_URL must be an isolated test database');
}

async function main() {
  await assertTestDatabase();
  const ids = process.argv.slice(2);
  if (!ids.length || !ids.every((id) => UUID.test(id))) throw new Error('drain-whatsapp: receipt ids required');
  for (const receiptId of ids) {
    const lease = randomUUID();
    const rows = await getWorkerPrisma().$queryRaw<Job[]>`
      UPDATE jobs SET status='running',attempts=attempts+1,lease_token=${lease}::uuid,lease_until=NOW()+INTERVAL '90 seconds',updated_at=NOW()
      WHERE dedupe_key=${`webhook:${receiptId}`} AND type='whatsapp.webhook' AND status='pending'
      RETURNING id,type,tenant_id,payload,attempts,max_attempts,lease_token`;
    const job = rows[0];
    if (!job) continue; // Already handled (a redelivery shares its receipt and job).
    try {
      await handleJob(job);
      await finishJob(job);
    } catch (error) {
      await finishJob(job, error);
      throw error;
    }
  }
}

main()
  .then(() => disconnectDatabases())
  .catch(async (error: unknown) => {
    // Test tooling against the local test database only; the message helps a failing spec.
    console.error('[drain-whatsapp] failed', error instanceof Error ? `${error.name}: ${error.message}` : 'Error');
    await disconnectDatabases().catch(() => undefined);
    process.exit(1);
  });
