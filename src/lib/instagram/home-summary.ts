// Instagram › Home (Stage 5, 5F): one read for the home page and the
// dashboard's "Next moves".
//
//   lastDays      the last 7 days: top automations by Instagram runs (with CTR),
//                 top posts by comments, leads collected (comment funnel), the
//                 top lead-collecting automation, automated messages sent, and
//                 the time saved, an estimate of 30 seconds per automated message
//   defaults      the always-on account defaults with their on/off state and the
//                 page that edits each
//   nextMoves     suggestions after the first setup steps, each ticked from real
//                 state (conversation starters, menu, default reply, a ref link,
//                 AI comment replies, a lead-capture automation)
//
// Every member may read it. Runs as the app role inside withTenant (FORCE RLS)
// and names account_id in every query. Counts, flow names and Instagram media
// ids only: no message text, contact, username or token leaves these queries.
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { channelPath } from '@/lib/channels/routes';
import { clickThroughRate, flowLinkStats } from '@/lib/flows/link-tracking';

export const HOME_WINDOW_DAYS = 7;
/** Seconds of a person's time one automated message is estimated to save. */
export const SECONDS_SAVED_PER_MESSAGE = 30;
const TOP_LIMIT = 5;

/** The time saved estimate for a number of automated messages, in whole hours and minutes. */
export function estimateTimeSaved(messages: number): { seconds: number; hours: number; minutes: number } {
  const seconds = Math.max(0, Math.floor(messages)) * SECONDS_SAVED_PER_MESSAGE;
  return { seconds, hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) };
}

export type HomeDefaultKey = 'defaultReply' | 'conversationStarters' | 'menu' | 'storyMentions' | 'keywords';
export type NextMoveKey = 'conversationStarters' | 'menu' | 'defaultReply' | 'refLink' | 'aiComments' | 'leadCapture';

export const NEXT_MOVE_HREF: Record<NextMoveKey, string> = {
  conversationStarters: channelPath('instagram', 'conversationStarters'),
  menu: channelPath('instagram', 'menu'),
  defaultReply: channelPath('instagram', 'defaultReply'),
  refLink: channelPath('instagram', 'refLinks'),
  aiComments: channelPath('instagram', 'comments'),
  leadCapture: channelPath('instagram', 'quickAutomations'),
};

const DEFAULT_HREF: Record<HomeDefaultKey, string> = {
  defaultReply: channelPath('instagram', 'defaultReply'),
  conversationStarters: channelPath('instagram', 'conversationStarters'),
  menu: channelPath('instagram', 'menu'),
  storyMentions: channelPath('instagram', 'flows'),
  keywords: channelPath('instagram', 'subscription'),
};

export interface HomeDefault {
  key: HomeDefaultKey;
  on: boolean;
  /** How many: active story-mention automations, custom keywords. */
  count?: number;
  /** Story mentions: the automation the Basics card opens (an active one first); absent when there is none. */
  flowId?: string;
  href: string;
}

export interface InstagramHomeSummary {
  since: string;
  lastDays: {
    topFlows: Array<{ id: string; name: string; runs: number; ctr: number | null }>;
    topPosts: Array<{ id: string; comments: number; leads: number }>;
    leads: number;
    topLeadFlow: { id: string; name: string; leads: number } | null;
    automatedMessages: number;
    timeSaved: { seconds: number; hours: number; minutes: number };
  };
  defaults: HomeDefault[];
  nextMoves: Array<{ key: NextMoveKey; done: boolean; href: string }>;
}

/** Order of the dashboard's next moves. */
export const NEXT_MOVES: readonly NextMoveKey[] = ['conversationStarters', 'menu', 'defaultReply', 'refLink', 'aiComments', 'leadCapture'];

/** Builds the next-moves list from the state flags (in NEXT_MOVES order). */
export function nextMovesFrom(state: Record<NextMoveKey, boolean>): InstagramHomeSummary['nextMoves'] {
  return NEXT_MOVES.map((key) => ({ key, done: state[key] === true, href: NEXT_MOVE_HREF[key] }));
}

/** A non-empty JSON array or object (ice breakers, persistent menu). */
const filledJson = (column: Prisma.Sql) => Prisma.sql`CASE jsonb_typeof(${column})
  WHEN 'array' THEN jsonb_array_length(${column}) > 0 WHEN 'object' THEN ${column} <> '{}'::jsonb ELSE false END`;
const IG_SCOPE = Prisma.sql`f.channel_scope IN ('instagram','any')`;

export async function instagramHomeSummaryTx(tx: TenantTransaction, accountId: string,
  now: Date = new Date()): Promise<InstagramHomeSummary> {
  const since = new Date(now.getTime() - HOME_WINDOW_DAYS * 86_400_000);
  const after = since.toISOString();

  const topFlows = await tx.$queryRaw<Array<{ id: string; name: string; runs: number }>>(Prisma.sql`
    SELECT r.flow_id::text AS id, f.name, count(*)::int AS runs
    FROM flow_runs r
    JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id
    JOIN conversations c ON c.account_id=r.account_id AND c.id=r.conversation_id
    WHERE r.account_id=${accountId}::uuid AND r.started_at >= ${after}::timestamptz AND c.channel='instagram'
    GROUP BY r.flow_id, f.name ORDER BY runs DESC, f.name LIMIT ${TOP_LIMIT}`);
  const stats = await flowLinkStats(tx, accountId, topFlows.map((flow) => flow.id), since);

  const topPosts = await tx.$queryRaw<Array<{ id: string; comments: number; leads: number }>>(Prisma.sql`
    SELECT e.media_id AS id, count(*)::int AS comments, count(e.lead_captured_at)::int AS leads
    FROM instagram_comment_events e
    WHERE e.account_id=${accountId}::uuid AND e.received_at >= ${after}::timestamptz AND e.media_id IS NOT NULL
    GROUP BY e.media_id ORDER BY comments DESC, e.media_id LIMIT ${TOP_LIMIT}`);

  const [{ leads }] = await tx.$queryRaw<{ leads: number }[]>(Prisma.sql`
    SELECT count(*)::int AS leads FROM instagram_comment_events e
    WHERE e.account_id=${accountId}::uuid AND e.lead_captured_at >= ${after}::timestamptz`);
  const [topLeadFlow] = await tx.$queryRaw<Array<{ id: string; name: string; leads: number }>>(Prisma.sql`
    SELECT r.flow_id::text AS id, f.name, count(*)::int AS leads
    FROM instagram_comment_events e
    JOIN flow_runs r ON r.account_id=e.account_id AND r.id=e.flow_run_id
    JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id
    WHERE e.account_id=${accountId}::uuid AND e.lead_captured_at >= ${after}::timestamptz
    GROUP BY r.flow_id, f.name ORDER BY leads DESC, f.name LIMIT 1`);

  const [{ messages }] = await tx.$queryRaw<{ messages: number }[]>(Prisma.sql`
    SELECT count(*)::int AS messages FROM messages m
    JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
    WHERE m.account_id=${accountId}::uuid AND c.channel='instagram' AND m.sender_type='bot'
      AND m.status IN ('sent','delivered','read') AND m.created_at >= ${after}::timestamptz`);

  const [state] = await tx.$queryRaw<Array<{
    default_reply: boolean; starters: boolean; menu: boolean; story_mentions: number; story_mention_flow: string | null;
    custom_keywords: number;
    ref_link: boolean; ai_comments: boolean; lead_capture: boolean;
  }>>(Prisma.sql`
    SELECT
      EXISTS(SELECT 1 FROM flows f WHERE f.account_id=${accountId}::uuid AND f.trigger_type='default_reply'
        AND f.channel_scope='instagram' AND f.status='active') AS default_reply,
      EXISTS(SELECT 1 FROM instagram_accounts a WHERE a.account_id=${accountId}::uuid AND a.status <> 'disconnected'
        AND ${filledJson(Prisma.sql`a.ice_breakers`)}) AS starters,
      EXISTS(SELECT 1 FROM instagram_accounts a WHERE a.account_id=${accountId}::uuid AND a.status <> 'disconnected'
        AND ${filledJson(Prisma.sql`a.persistent_menu`)}) AS menu,
      (SELECT count(*)::int FROM flows f WHERE f.account_id=${accountId}::uuid AND f.trigger_type='ig_story_mention'
        AND ${IG_SCOPE} AND f.status='active') AS story_mentions,
      (SELECT f.id::text FROM flows f WHERE f.account_id=${accountId}::uuid AND f.trigger_type='ig_story_mention'
        AND ${IG_SCOPE} AND f.status <> 'archived' ORDER BY (f.status='active') DESC, f.updated_at DESC LIMIT 1) AS story_mention_flow,
      COALESCE((SELECT COALESCE(cardinality(s.opt_out_keywords), 0) + COALESCE(cardinality(s.opt_in_keywords), 0)
        FROM instagram_consent_settings s WHERE s.account_id=${accountId}::uuid), 0)::int AS custom_keywords,
      EXISTS(SELECT 1 FROM flows f WHERE f.account_id=${accountId}::uuid AND f.trigger_type='ig_ref' AND ${IG_SCOPE}
        AND f.status <> 'archived') AS ref_link,
      COALESCE((SELECT a.instagram_ai_comments_enabled FROM ai_configs a WHERE a.account_id=${accountId}::uuid LIMIT 1), false) AS ai_comments,
      EXISTS(SELECT 1 FROM flow_nodes n JOIN flows f ON f.account_id=n.account_id AND f.id=n.flow_id
        WHERE n.account_id=${accountId}::uuid AND ${IG_SCOPE} AND f.status <> 'archived'
          AND n.node_type='collect_input' AND n.config->>'validation' IN ('email','phone')) AS lead_capture`);

  return {
    since: after,
    lastDays: {
      topFlows: topFlows.map((flow) => ({ ...flow, ctr: clickThroughRate(stats.get(flow.id)) })),
      topPosts,
      leads: leads ?? 0,
      topLeadFlow: topLeadFlow ?? null,
      automatedMessages: messages ?? 0,
      timeSaved: estimateTimeSaved(messages ?? 0),
    },
    defaults: [
      { key: 'defaultReply', on: state.default_reply, href: DEFAULT_HREF.defaultReply },
      { key: 'conversationStarters', on: state.starters, href: DEFAULT_HREF.conversationStarters },
      { key: 'menu', on: state.menu, href: DEFAULT_HREF.menu },
      {
        key: 'storyMentions', on: state.story_mentions > 0, count: state.story_mentions,
        ...(state.story_mention_flow ? { flowId: state.story_mention_flow } : {}),
        href: state.story_mention_flow ? channelPath('instagram', 'flows', state.story_mention_flow) : DEFAULT_HREF.storyMentions,
      },
      // The built-in STOP and START words always work; custom words are counted.
      { key: 'keywords', on: true, count: state.custom_keywords, href: DEFAULT_HREF.keywords },
    ],
    nextMoves: nextMovesFrom({
      conversationStarters: state.starters,
      menu: state.menu,
      defaultReply: state.default_reply,
      refLink: state.ref_link,
      aiComments: state.ai_comments,
      leadCapture: state.lead_capture,
    }),
  };
}

export function instagramHomeSummary(context: TenantContext, now?: Date): Promise<InstagramHomeSummary> {
  return withTenant(context, (tx) => instagramHomeSummaryTx(tx, context.accountId, now));
}
