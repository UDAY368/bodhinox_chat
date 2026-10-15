import { readBoundedBody } from '@/lib/api/bounded-body';
import { ForbiddenError } from '@/lib/auth/errors';
import { requireSession, assertMutation } from '@/lib/auth/session';
import { getMedia, putMedia, removeMedia } from '@/lib/storage/server';
export const runtime = 'nodejs';
function failure(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 400;
  const message = error instanceof Error && /Missing required configuration/.test(error.message) ? 'Media storage is not configured' : error instanceof Error && /not found/.test(error.message) ? 'Media not found' : 'Media request was rejected';
  return Response.json({ error: { message } }, { status: message.includes('not configured') ? 503 : status, headers: { 'Cache-Control': 'no-store' } });
}
export async function GET(request: Request) {
  try {
    const context = await requireSession(request); const url = new URL(request.url);
    const { object, contentType } = await getMedia(context, url.searchParams.get('bucket') || '', url.searchParams.get('key') || '');
    if (!object.Body) return Response.json({ error: { message: 'Media not found' } }, { status: 404 });
    return new Response(object.Body.transformToWebStream() as ReadableStream<Uint8Array>, { headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const context = await requireSession(request); await assertMutation(request, context);
    if (Number(request.headers.get('content-length') || 0) > 17 * 1024 * 1024) return Response.json({ error: { message: 'Upload too large' } }, { status: 413 });
    if (context.role === 'viewer') throw new ForbiddenError('Uploads require an agent role');
    const bytes = await readBoundedBody(request, 17 * 1024 * 1024);
    const form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } }).formData(); const file = form.get('file');
    if (!(file instanceof File) || file.size > 16 * 1024 * 1024) throw new Error('Invalid upload');
    await putMedia(context, String(form.get('bucket')), String(form.get('key')), new Uint8Array(await file.arrayBuffer()), file.type, form.get('upsert') === 'true');
    return Response.json({ data: { path: String(form.get('key')) } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    const context = await requireSession(request); await assertMutation(request, context);
    const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 32 * 1024)));
    if (typeof body.bucket !== 'string' || !Array.isArray(body.paths) || body.paths.length > 50 || body.paths.some((p: unknown) => typeof p !== 'string')) throw new Error('Invalid delete request');
    for (const path of body.paths) await removeMedia(context, body.bucket, path);
    return Response.json({ data: { removed: body.paths.length } });
  } catch (error) { return failure(error); }
}
