import { createHash } from 'node:crypto'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { verifyWebhookTokenHash } from '@/lib/repositories/routing'
import { persistWebhook } from '@/lib/jobs/queue'

export const runtime = 'nodejs'
const MAX_BYTES = 2 * 1024 * 1024
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')
  if (params.get('hub.mode') !== 'subscribe' || !token || token.length > 512 || !challenge || challenge.length > 512) return new Response('Forbidden', { status: 403 })
  try {
    const valid = await verifyWebhookTokenHash(createHash('sha256').update(token).digest('hex'))
    return valid ? new Response(challenge, { headers: { 'Content-Type': 'text/plain' } }) : new Response('Forbidden', { status: 403 })
  } catch { return new Response('Verification unavailable', { status: 503 }) }
}
export async function POST(request: Request) {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response('Payload too large', { status: 413 })
  const reader = request.body?.getReader()
  if (!reader) return new Response('Missing body', { status: 400 })
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    bytes += item.value.byteLength
    if (bytes > MAX_BYTES) { await reader.cancel(); return new Response('Payload too large', { status: 413 }) }
    chunks.push(item.value)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!verifyMetaWebhookSignature(raw, request.headers.get('x-hub-signature-256'))) return new Response('Invalid signature', { status: 401 })
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
    if (!payload || !Array.isArray(payload.entry) || payload.entry.length > 100 || payload.entry.some((entry: unknown) => !entry || typeof entry !== 'object' || !Array.isArray((entry as { changes?: unknown }).changes) || ((entry as { changes: unknown[] }).changes.length > 100))) throw new Error('Invalid payload')
  } catch { return new Response('Invalid payload', { status: 400 }) }
  try {
    const receiptId = await persistWebhook(raw, payload)
    return Response.json({ status: 'received', receipt_id: receiptId })
  } catch { return new Response('Persistence unavailable; retry delivery', { status: 503 }) }
}
