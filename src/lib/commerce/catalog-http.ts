import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { CatalogError } from './catalog';

/** Catalogue refusals become `{ error, code }` with their status; anything else is a generic 500. */
export function catalogErrorResponse(error: unknown): NextResponse {
  if (error instanceof CatalogError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}
