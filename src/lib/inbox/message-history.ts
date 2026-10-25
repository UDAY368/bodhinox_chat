import type { DataClient } from '@/lib/data/types';
import type { Message } from '@/types';
export const MESSAGE_PAGE_SIZE = 50;
export async function loadMessagePage(
  db: DataClient,
  conversationId: string,
  before?: Pick<Message, 'id' | 'created_at'>
) {
  let query = db
    .from('messages')
    .select<Message>('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
  if (before)
    query = query.or(
      `created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`
    );
  const result = await query;
  return { ...result, data: result.data ? [...result.data].reverse() : null };
}
