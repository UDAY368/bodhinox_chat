// /api/integrations/google-sheets — the workspace's Google Sheets connection (Stage 5, 5G).
//   GET     any member: { available, reason, connected, status, google_email, connected_at }. Never a token.
//   DELETE  admin: removes the connection (revoked at Google best-effort), audited. Allowed while the
//           integration is off so a stored token can always be cleared.
// Mutations need the session's Origin + CSRF proof.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { disconnectSheets, getSheetsConnection } from '@/lib/integrations/google-sheets/connection';
import { NO_STORE, sheetsActorOf, sheetsAdminMutation, sheetsErrorResponse } from '@/lib/integrations/google-sheets/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    return NextResponse.json(await getSheetsConnection(sheetsActorOf(session)), { headers: NO_STORE });
  } catch (error) {
    return sheetsErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await sheetsAdminMutation(request);
    if (session instanceof NextResponse) return session;
    return NextResponse.json(await disconnectSheets(sheetsActorOf(session)), { headers: NO_STORE });
  } catch (error) {
    return sheetsErrorResponse(error);
  }
}
