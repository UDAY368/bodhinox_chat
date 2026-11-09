import type { Deal } from '@/types';
import type { DataClient } from '@/lib/data/types';
import { fetchAllPages } from '@/lib/data/paged-query';

export const DEAL_SELECT = '*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)';

/**
 * Every deal in a pipeline, newest first, read in 1,000-row pages so the board
 * and its totals never stop at the data API's 1,000-row cap. The id tiebreak
 * keeps pages stable when deals share a created_at; a deal created while the
 * pages are read (an automation's create_deal step) shifts the offsets, so a
 * row repeated across a page boundary is kept once.
 */
export async function loadPipelineDeals(db: DataClient, pipelineId: string): Promise<Deal[]> {
  const rows = await fetchAllPages<Deal>((from, to) => db
    .from('deals')
    .select<Deal>(DEAL_SELECT)
    .eq('pipeline_id', pipelineId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to));
  const seen = new Set<string>();
  return rows.filter((deal) => !seen.has(deal.id) && Boolean(seen.add(deal.id)));
}
