import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { AttributeError } from './attributes';

/** Attribute input errors are 400 with a safe message; anything else is generic. */
export function attributeError(err: unknown): NextResponse {
  if (err instanceof AttributeError) return NextResponse.json({ error: err.message }, { status: 400 });
  return toErrorResponse(err);
}
