import { config } from 'dotenv'
config({ path: process.env.DATABASE_ENV_FILE || '.env.local', quiet: true })
import { getWorkerPrisma } from '@/lib/db/prisma'
import { runWorkerLoop } from './worker-loop'
import { createOpsAlerter } from '@/lib/ops/alerts'

// SIGTERM/SIGINT: stop claiming, let the in-flight job finish within WORKER_DRAIN_MS (default 25 s),
// otherwise exit and let its lease expire so another worker reclaims it.
const controller = new AbortController()
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())

async function main() {
  await getWorkerPrisma().$queryRaw`SELECT 1`
  console.info('[worker] ready')
  // Optional OPS_ALERT_WEBHOOK_URL; unset = no-op (no database read either).
  const alerts = createOpsAlerter()
  const result = await runWorkerLoop({ signal: controller.signal, afterSchedule: () => alerts.tick() })
  // A job still running past the drain bound: exit now, before disconnecting. pg-pool's end() waits
  // for checked-out clients, so awaiting $disconnect() here would hold the process past the bound.
  // The job's lease expires and another worker reclaims it.
  if (!result.drained) process.exit(0)
  await getWorkerPrisma().$disconnect()
}
main().catch(() => { console.error('[worker] startup failed'); process.exitCode = 1 })
