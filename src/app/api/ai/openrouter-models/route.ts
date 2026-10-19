import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { freeOpenRouterModels, OPENROUTER_BASE_URL } from '@/lib/ai/openrouter'

/** Public model metadata only; no account key is sent to the catalogue. */
export async function GET() {
  try {
    await requireRole('admin')
    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(10_000), redirect: 'error', next: { revalidate: 300 } })
      if (!response.ok) throw new Error('Catalogue unavailable')
      return NextResponse.json({ models: freeOpenRouterModels(await response.json()), available: true }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return NextResponse.json({ models: freeOpenRouterModels(null), available: false }, { headers: { 'Cache-Control': 'no-store' } })
    }
  } catch (error) { return toErrorResponse(error) }
}
