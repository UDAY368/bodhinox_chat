import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseReplyTarget } from '@/lib/settings/reply-target';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.db.from('accounts').select('reply_target_minutes').eq('id', ctx.accountId).single();
    if (error) throw error;
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return toErrorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const raw = body?.reply_target_minutes;
    const target = typeof raw === 'number' || typeof raw === 'string' ? parseReplyTarget(String(raw)) : null;
    if (target === null) return NextResponse.json({ error: 'Reply target must be a whole number from 1 to 1440 minutes.' }, { status: 400 });
    const { data, error } = await ctx.db.from('accounts').update({ reply_target_minutes: target }).eq('id', ctx.accountId).select('reply_target_minutes').single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) { return toErrorResponse(error); }
}
