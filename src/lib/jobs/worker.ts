import { withLeaseScope } from './lease'
import { config } from 'dotenv'
config({ path: process.env.DATABASE_ENV_FILE || '.env.local', quiet: true })
import { claimJob, finishJob, heartbeat } from './queue'
import { getWorkerPrisma } from '@/lib/db/prisma'

let stopping = false
process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  // Load modules that capture provider settings only after dotenv has run.
  const { handleJob, scheduleWork } = await import('./handlers')
  await getWorkerPrisma().$queryRaw`SELECT 1`
  console.info('[worker] ready')
  let nextSchedule = 0
  while (!stopping) {
    if (Date.now() >= nextSchedule) {
      try { await scheduleWork() } catch { console.error('[worker] scheduling failed') }
      nextSchedule = Date.now() + 30_000
    }
    const job = await claimJob()
    if (!job) { await delay(1000); continue }
    let leaseLost = false
    const timer = setInterval(() => { void heartbeat(job).then(count => { if (!count) leaseLost = true }).catch(() => { leaseLost = true }) }, 20_000)
    try {
      const assertLease = () => { if (leaseLost) throw new Error('Job lease lost') }
      await withLeaseScope(assertLease, () => handleJob(job, assertLease))
      await finishJob(job)
    } catch (error) {
      console.error('[worker] job failed', { id: job.id, type: job.type, category: error instanceof Error ? error.name : 'Error' })
      await finishJob(job, error)
    } finally { clearInterval(timer) }
  }
  await getWorkerPrisma().$disconnect()
}
main().catch(() => { console.error('[worker] startup failed'); process.exitCode = 1 })
