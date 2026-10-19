import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { fetchAllPages } from '@/lib/data/paged-query';

export async function GET() {
  try {
    const { db, accountId } = await requireRole('agent');
    const [automations, flows] = await Promise.all([
      fetchAllPages((from, to) => db.from('automations').select('id,name,is_active').eq('account_id', accountId).order('name').order('id').range(from, to)),
      fetchAllPages((from, to) => db.from('flows').select('id,name,status').eq('account_id', accountId).order('name').order('id').range(from, to)),
    ]);
    return NextResponse.json({ automations, flows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return toErrorResponse(error); }
}
