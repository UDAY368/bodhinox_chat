// The Sales pipeline board, read on the server. Every query runs in the member's
// own tenant transaction (RLS), names its account and pipeline, and is bounded:
// - loadBoard: the first page of each stage's deals for one view (open, won or
//   lost), each stage's count and value per currency, and the pipeline overview
//   (count and value per status and currency) for the summary cards;
// - loadStageDeals: the next page of one stage ("Load more");
// - getDeal: one deal by id (the /pipelines?deal=<id> link), 404 outside the workspace.
// Values are never summed across currencies; each currency is its own total.
// A member whose numbers are masked gets masked contact phones and can match a
// number only by its last digits (the same rule as contact search).
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { maskPhone } from '@/lib/inbox/masking';
import { loadPhoneMask } from '@/lib/inbox/masking-apply';
import { contactMatchSql } from '@/lib/search/contacts';

export const BOARD_PAGE_SIZE = 25;
export const DEAL_SEARCH_MAX = 100;
const MAX_OFFSET = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BoardView = 'open' | 'won' | 'lost';
export const BOARD_VIEWS: readonly BoardView[] = ['open', 'won', 'lost'];

export interface BoardFilters {
  view: BoardView;
  /** "all", "none" (unassigned) or a profile id. */
  owner: string;
  /** Matches the deal title or the contact's name or phone. */
  q: string;
}

export interface BoardDeal {
  id: string;
  user_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  assigned_to: string | null;
  title: string;
  value: number;
  currency: string;
  notes: string | null;
  expected_close_date: string | null;
  status: BoardView;
  created_at: string;
  updated_at: string | null;
  closed_at: string | null;
  lost_reason: string | null;
  contact: { id: string; name: string | null; phone: string } | null;
  assignee: { id: string; full_name: string; email: string } | null;
}

export interface CurrencyTotal { currency: string; count: number; total: number }
export interface StageSummary { stage_id: string; count: number; totals: CurrencyTotal[] }
/** Deals of one status, stage and currency; this_month counts those closed since the month began (server time). */
export interface OverviewRow { status: BoardView; stage_id: string; currency: string; count: number; total: number; this_month: number }

export class BoardError extends Error {
  constructor(readonly code: 'invalid' | 'not_found', readonly status: number) {
    super(code);
    this.name = 'BoardError';
  }
}

/** BoardError -> { error, code } with its status; auth errors as usual; anything else a generic 500. */
export function boardErrorResponse(error: unknown): NextResponse {
  if (error instanceof BoardError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

/** Query-string filters -> BoardFilters; throws invalid on anything unexpected. */
export function parseBoardFilters(params: URLSearchParams): BoardFilters {
  const view = (params.get('view') ?? 'open') as BoardView;
  const owner = params.get('owner') ?? 'all';
  const q = (params.get('q') ?? '').trim();
  if (!BOARD_VIEWS.includes(view)) throw new BoardError('invalid', 400);
  if (owner !== 'all' && owner !== 'none' && !UUID.test(owner)) throw new BoardError('invalid', 400);
  if (q.length > DEAL_SEARCH_MAX) throw new BoardError('invalid', 400);
  return { view, owner, q };
}

export function parseOffset(raw: string | null): number {
  const n = raw === null || raw === '' ? 0 : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) throw new BoardError('invalid', 400);
  return n;
}

export const isUuid = (id: string): boolean => UUID.test(id);

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The WHERE clause for one pipeline under the owner and search filters (no status). */
function scope(ctx: TenantContext, pipelineId: string, f: Pick<BoardFilters, 'owner' | 'q'>, maskPhones: boolean): Prisma.Sql {
  const parts = [Prisma.sql`d.account_id=${ctx.accountId}::uuid`, Prisma.sql`d.pipeline_id=${pipelineId}::uuid`];
  if (f.owner === 'none') parts.push(Prisma.sql`d.assigned_to IS NULL`);
  else if (f.owner !== 'all') parts.push(Prisma.sql`d.assigned_to=${f.owner}::uuid`);
  if (f.q) {
    parts.push(Prisma.sql`(d.title ILIKE ${likePattern(f.q)} OR (c.id IS NOT NULL ${contactMatchSql(f.q, maskPhones)}))`);
  }
  return Prisma.join(parts, ' AND ');
}

const statusOf = Prisma.sql`COALESCE(d.status,'open')`;

const DEAL_COLUMNS = Prisma.sql`d.id::text AS id, d.user_id::text AS user_id, d.pipeline_id::text AS pipeline_id,
  d.stage_id::text AS stage_id, d.contact_id::text AS contact_id, d.conversation_id::text AS conversation_id,
  d.assigned_to::text AS assigned_to, d.title, d.value::float8 AS value, COALESCE(d.currency,'USD') AS currency,
  d.notes, to_char(d.expected_close_date,'YYYY-MM-DD') AS expected_close_date, ${statusOf} AS status,
  d.created_at, d.updated_at, d.closed_at, d.lost_reason,
  c.id::text AS c_id, c.name AS c_name, c.phone AS c_phone,
  p.id::text AS p_id, p.full_name AS p_name, p.email AS p_email`;
const DEAL_JOINS = Prisma.sql`LEFT JOIN contacts c ON c.account_id=d.account_id AND c.id=d.contact_id
  LEFT JOIN profiles p ON p.id=d.assigned_to`;
// Newest first; the id breaks ties so offsets stay stable.
const DEAL_ORDER = Prisma.sql`d.created_at DESC NULLS LAST, d.id`;

type DealRow = Omit<BoardDeal, 'contact' | 'assignee' | 'created_at' | 'updated_at' | 'closed_at'> & {
  created_at: Date | null; updated_at: Date | null; closed_at: Date | null;
  c_id: string | null; c_name: string | null; c_phone: string | null;
  p_id: string | null; p_name: string | null; p_email: string | null;
};

function toDeal(r: DealRow, maskPhones: boolean): BoardDeal {
  const { c_id, c_name, c_phone, p_id, p_name, p_email, created_at, updated_at, closed_at, ...rest } = r;
  // The board query's row_number (a bigint) never reaches JSON.
  delete (rest as { rn?: unknown }).rn;
  return {
    ...rest,
    value: Number(rest.value),
    created_at: (created_at ?? new Date(0)).toISOString(),
    updated_at: updated_at?.toISOString() ?? null,
    closed_at: closed_at?.toISOString() ?? null,
    contact: c_id ? { id: c_id, name: c_name, phone: maskPhones ? maskPhone(c_phone) : c_phone ?? '' } : null,
    assignee: p_id ? { id: p_id, full_name: p_name ?? '', email: p_email ?? '' } : null,
  };
}

async function assertPipeline(tx: Prisma.TransactionClient, ctx: TenantContext, pipelineId: string) {
  const found = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM pipelines
    WHERE account_id=${ctx.accountId}::uuid AND id=${pipelineId}::uuid`;
  if (!found[0]) throw new BoardError('not_found', 404);
}

export interface Board {
  stages: StageSummary[];
  deals: BoardDeal[];
  overview: OverviewRow[];
}

/** The first page of every stage for the view, with stage totals and the overview. */
export async function loadBoard(ctx: TenantContext, pipelineId: string, f: BoardFilters): Promise<Board> {
  if (!isUuid(pipelineId)) throw new BoardError('not_found', 404);
  return withTenant(ctx, async (tx) => {
    await assertPipeline(tx, ctx, pipelineId);
    const mask = await loadPhoneMask(tx, ctx);
    const where = scope(ctx, pipelineId, f, mask);
    const deals = await tx.$queryRaw<DealRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT ${DEAL_COLUMNS}, row_number() OVER (PARTITION BY d.stage_id ORDER BY ${DEAL_ORDER}) AS rn
        FROM deals d ${DEAL_JOINS}
        WHERE ${where} AND ${statusOf}=${f.view}
      ) ranked WHERE rn <= ${BOARD_PAGE_SIZE} ORDER BY stage_id, rn`);
    // One bounded aggregate (status x stage x currency) feeds both the stage headers of
    // this view and the overview cards; currencies are never added together.
    const rows = await tx.$queryRaw<OverviewRow[]>(Prisma.sql`
      SELECT ${statusOf} AS status, d.stage_id::text AS stage_id, COALESCE(d.currency,'USD') AS currency,
        count(*)::int AS count, sum(d.value)::float8 AS total,
        (count(*) FILTER (WHERE d.closed_at >= date_trunc('month', now())))::int AS this_month
      FROM deals d LEFT JOIN contacts c ON c.account_id=d.account_id AND c.id=d.contact_id
      WHERE ${where}
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    const overview = rows.map((r) => ({ ...r, total: Number(r.total) }));
    return {
      stages: groupStageTotals(overview.filter((r) => r.status === f.view)),
      deals: deals.map((r) => toDeal(r, mask)),
      overview,
    };
  });
}

/** Stage rows grouped per currency -> one summary per stage (count across currencies, a total per currency). */
export function groupStageTotals(rows: { stage_id: string; currency: string; count: number; total: number }[]): StageSummary[] {
  const byStage = new Map<string, StageSummary>();
  for (const r of rows) {
    const s = byStage.get(r.stage_id) ?? { stage_id: r.stage_id, count: 0, totals: [] };
    s.count += r.count;
    s.totals.push({ currency: r.currency, count: r.count, total: Number(r.total) });
    byStage.set(r.stage_id, s);
  }
  return [...byStage.values()];
}

/** One more page of a stage, after `offset` deals. */
export async function loadStageDeals(ctx: TenantContext, pipelineId: string, stageId: string, f: BoardFilters, offset: number):
  Promise<{ deals: BoardDeal[]; hasMore: boolean }> {
  if (!isUuid(pipelineId) || !isUuid(stageId)) throw new BoardError('not_found', 404);
  return withTenant(ctx, async (tx) => {
    await assertPipeline(tx, ctx, pipelineId);
    const mask = await loadPhoneMask(tx, ctx);
    const rows = await tx.$queryRaw<DealRow[]>(Prisma.sql`
      SELECT ${DEAL_COLUMNS} FROM deals d ${DEAL_JOINS}
      WHERE ${scope(ctx, pipelineId, f, mask)} AND d.stage_id=${stageId}::uuid AND ${statusOf}=${f.view}
      ORDER BY ${DEAL_ORDER} LIMIT ${BOARD_PAGE_SIZE + 1} OFFSET ${offset}`);
    return { deals: rows.slice(0, BOARD_PAGE_SIZE).map((r) => toDeal(r, mask)), hasMore: rows.length > BOARD_PAGE_SIZE };
  });
}

/** One deal of this workspace; 404 for an unknown id or another workspace's deal. */
export async function getDeal(ctx: TenantContext, dealId: string): Promise<BoardDeal> {
  if (!isUuid(dealId)) throw new BoardError('not_found', 404);
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<DealRow[]>(Prisma.sql`
      SELECT ${DEAL_COLUMNS} FROM deals d ${DEAL_JOINS}
      WHERE d.account_id=${ctx.accountId}::uuid AND d.id=${dealId}::uuid`);
    if (!rows[0]) throw new BoardError('not_found', 404);
    return toDeal(rows[0], await loadPhoneMask(tx, ctx));
  });
}
