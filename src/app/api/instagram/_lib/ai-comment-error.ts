// Error mapping of the AI comment routes: the two 409s the queue adds on top of
// the shared Instagram errors (ai_not_configured, already_decided).
import { NextResponse } from 'next/server';
import { AiCommentError } from '@/lib/instagram/ai-comments-queue';
import { NO_STORE } from '@/lib/instagram/http';
import { routeError } from './route';

export function aiCommentRouteError(error: unknown): NextResponse {
  if (error instanceof AiCommentError) return NextResponse.json({ error: error.code }, { status: 409, headers: NO_STORE });
  return routeError(error);
}
