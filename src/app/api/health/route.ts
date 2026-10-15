import { getPrisma } from '@/lib/db/prisma'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    await getPrisma().$queryRaw`SELECT bot_paused FROM conversations LIMIT 0`
    return Response.json({ status: 'ok', application: 'Bodhinox Chat' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ status: 'unavailable' }, { status: 503 }) }
}
