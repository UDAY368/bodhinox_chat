import { appDatabaseReachable, deepHealth, deepHealthAuthorized } from '@/lib/ops/health'
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/health is the Railway healthcheck and Playwright readiness probe: its behaviour and shape
// are unchanged. The deep operations check answers only `?deep=1` with `Authorization: Bearer
// <HEALTH_TOKEN>`; without a valid token the request gets the plain response, so nothing reveals
// that a deep mode exists. The token is never read from the URL.
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get('deep') === '1' && deepHealthAuthorized(request.headers.get('authorization'))) {
    const limit = checkRateLimit('ops-health-deep', RATE_LIMITS.opsHealth)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await deepHealth()
    return Response.json(body, { status: body.status === 'down' ? 503 : 200, headers: { 'Cache-Control': 'no-store' } })
  }
  if (await appDatabaseReachable())
    return Response.json({ status: 'ok', application: 'Bodhinox Chat' }, { headers: { 'Cache-Control': 'no-store' } })
  return Response.json({ status: 'unavailable' }, { status: 503 })
}
