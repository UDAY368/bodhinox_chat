import { NextResponse } from 'next/server';

import { BodyTooLargeError } from '@/lib/api/bounded-body';
import { toErrorResponse } from '@/lib/auth/account';
import { MediaLibraryError } from './media-library';

const noStore = { 'Cache-Control': 'no-store' };

/** Library refusals become `{ error, code }` with their status; storage errors get a safe message. */
export function mediaLibraryErrorResponse(error: unknown): NextResponse {
  if (error instanceof MediaLibraryError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: noStore });
  if (error instanceof BodyTooLargeError) return NextResponse.json({ error: 'Upload too large', code: 'too_large' }, { status: 413, headers: noStore });
  if (error instanceof Error && /Missing required configuration/.test(error.message))
    return NextResponse.json({ error: 'Media storage is not configured', code: 'storage_unconfigured' }, { status: 503, headers: noStore });
  if (error instanceof Error && /Unsupported media type|exceeds the permitted size/.test(error.message))
    return NextResponse.json({ error: error.message, code: 'invalid_upload' }, { status: 400, headers: noStore });
  return toErrorResponse(error);
}
