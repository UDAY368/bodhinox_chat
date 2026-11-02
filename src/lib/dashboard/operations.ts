import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import type { DashboardOperations } from './operations-types';
import { loadPhoneMask } from '@/lib/inbox/masking-apply';

/** SQL aggregates keep large tenants off browser row caps and scope every join. */
export async function loadDashboardOperations(context: TenantContext, days = 7): Promise<DashboardOperations> {
  if (![7, 30, 90].includes(days)) throw new RangeError('Unsupported overview range');
  return withTenant(context, async tx => {
    // A member whose numbers are masked sees 'Contact' rather than an unnamed contact's number.
    const phoneName = (await loadPhoneMask(tx, context)) ? Prisma.sql`NULL` : Prisma.sql`ct.phone`;
    const rows = await tx.$queryRaw<{ overview: DashboardOperations }[]>(Prisma.sql`
      WITH settings AS (
        SELECT reply_target_minutes FROM accounts WHERE id=${context.accountId}::uuid
      ), message_state AS (
        SELECT conversation_id,
          max(created_at) FILTER (WHERE sender_type='customer') AS inbound_at,
          max(created_at) FILTER (WHERE sender_type IN ('agent','bot') AND status IN ('sent','delivered','read')
            AND content_type NOT IN ('template','system')) AS reply_at
        FROM messages WHERE account_id=${context.accountId}::uuid GROUP BY conversation_id
      ), queue_state AS (
        SELECT c.id, coalesce(nullif(ct.name,''),${phoneName},'Contact') AS name,
          c.assigned_agent_id, c.bot_paused AS handed_off, s.inbound_at,
          s.inbound_at + interval '24 hours' AS closes_at,
          (c.status <> 'closed' AND s.inbound_at IS NOT NULL AND (s.reply_at IS NULL OR s.reply_at < s.inbound_at)) AS waiting
        FROM conversations c LEFT JOIN message_state s ON s.conversation_id=c.id
        LEFT JOIN contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id
        WHERE c.account_id=${context.accountId}::uuid
      ), real_replies AS (
        SELECT m.sender_id,m.sender_type,m.created_at,inbound.created_at AS inbound_at,
          NOT EXISTS (
            SELECT 1 FROM messages previous
            WHERE previous.account_id=m.account_id AND previous.conversation_id=m.conversation_id
              AND previous.sender_type IN ('agent','bot') AND previous.status IN ('sent','delivered','read')
              AND previous.content_type NOT IN ('template','system') AND previous.created_at>=inbound.created_at
              AND (previous.created_at,previous.arrival_sequence)<(m.created_at,m.arrival_sequence)
          ) AS is_first_reply
        FROM messages m
        JOIN LATERAL (
          SELECT i.id,i.created_at FROM messages i
          WHERE i.account_id=m.account_id AND i.conversation_id=m.conversation_id
            AND i.sender_type='customer' AND i.created_at <= m.created_at
          ORDER BY i.created_at DESC,i.arrival_sequence DESC LIMIT 1
        ) inbound ON true
        WHERE m.account_id=${context.accountId}::uuid AND m.sender_type IN ('agent','bot')
          AND m.status IN ('sent','delivered','read') AND m.content_type NOT IN ('template','system')
          AND m.created_at >= now() - (${days} * interval '1 day')
      ), period_replies AS (
        SELECT * FROM real_replies WHERE created_at >= now()-(${days} * interval '1 day')
      ), failures AS (
        SELECT m.id,m.conversation_id,coalesce(nullif(ct.name,''),${phoneName},'Contact') AS name,
          left(coalesce(m.content_text,m.template_name,'Message'),160) AS preview,m.created_at
        FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.account_id=m.account_id
        LEFT JOIN contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id
        WHERE m.account_id=${context.accountId}::uuid AND m.status='failed'
          AND m.sender_type IN ('agent','bot') AND m.created_at >= now()-(${days} * interval '1 day')
      ), team AS (
        SELECT p.user_id AS id,p.full_name AS name,
          (SELECT count(*) FROM conversations c WHERE c.account_id=${context.accountId}::uuid AND c.assigned_agent_id=p.user_id AND c.status='open') AS open,
          (SELECT count(*) FROM period_replies r WHERE r.sender_id=p.user_id AND r.sender_type='agent') AS replies,
          (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM (r.created_at-r.inbound_at))/60)
            FROM period_replies r WHERE r.sender_id=p.user_id AND r.sender_type='agent' AND r.is_first_reply) AS "medianMinutes"
        FROM account_memberships membership JOIN profiles p ON p.user_id=membership.user_id
        WHERE membership.account_id=${context.accountId}::uuid
      ), pipeline AS (
        SELECT p.id,p.name,count(d.id) FILTER(WHERE d.status='open') AS open,
          count(d.id) FILTER(WHERE d.status='won' AND d.updated_at>=now()-(${days}*interval '1 day')) AS won,
          count(d.id) FILTER(WHERE d.status='lost' AND d.updated_at>=now()-(${days}*interval '1 day')) AS lost,
          count(d.id) FILTER(WHERE d.status='open' AND d.updated_at<now()-interval '7 days') AS idle,
          avg(extract(epoch FROM(d.updated_at-d.created_at))/86400) FILTER(WHERE d.status='won' AND d.updated_at>=now()-(${days}*interval '1 day')) AS "avgDaysToWin"
        FROM pipelines p LEFT JOIN deals d ON d.pipeline_id=p.id AND d.account_id=p.account_id
        WHERE p.account_id=${context.accountId}::uuid GROUP BY p.id,p.name
      ) SELECT json_build_object(
        'days',${days}::integer,'replyTargetMinutes',(SELECT reply_target_minutes FROM settings),
        'attention',json_build_object(
          'waiting',(SELECT count(*) FROM queue_state WHERE waiting),
          'overTarget',(SELECT count(*) FROM queue_state WHERE waiting AND inbound_at < now()-((SELECT reply_target_minutes FROM settings)*interval '1 minute')),
          'unassigned',(SELECT count(*) FROM conversations WHERE account_id=${context.accountId}::uuid AND status='open' AND assigned_agent_id IS NULL),
          'expiring',(SELECT count(*) FROM queue_state WHERE waiting AND closes_at>now() AND closes_at<=now()+interval '2 hours'),
          'failed',(SELECT count(*) FROM failures)),
        'queue',coalesce((SELECT json_agg(q) FROM (SELECT id,name,inbound_at AS "waitingSince",closes_at AS "closesAt",assigned_agent_id IS NOT NULL AS assigned,coalesce(handed_off,false) AS "handedOff" FROM queue_state WHERE waiting ORDER BY inbound_at LIMIT 20) q),'[]'::json),
        'failedMessages',coalesce((SELECT json_agg(f) FROM (SELECT id,conversation_id AS "conversationId",name,preview,created_at AS at FROM failures ORDER BY created_at DESC LIMIT 20) f),'[]'::json),
        'team',coalesce((SELECT json_agg(t ORDER BY t.name) FROM team t),'[]'::json),
        'automated',json_build_object('replies',(SELECT count(*) FROM period_replies WHERE sender_type='bot'),
          'medianMinutes',(SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM(created_at-inbound_at))/60) FROM period_replies WHERE sender_type='bot' AND is_first_reply)),
        'pipelines',coalesce((SELECT json_agg(p ORDER BY p.name) FROM pipeline p),'[]'::json),
        'campaigns',json_build_object(
          'automationRuns',(SELECT count(*) FROM automation_logs WHERE account_id=${context.accountId}::uuid AND created_at>=now()-(${days}*interval '1 day')),
          'automationFailed',(SELECT count(*) FROM automation_logs WHERE account_id=${context.accountId}::uuid AND status='failed' AND created_at>=now()-(${days}*interval '1 day')),
          'flowFailed',(SELECT count(*) FROM flow_runs WHERE account_id=${context.accountId}::uuid AND status='failed' AND started_at>=now()-(${days}*interval '1 day')),
          'topFailingFlow',(SELECT f.name FROM flow_runs r JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id WHERE r.account_id=${context.accountId}::uuid AND r.status='failed' AND r.started_at>=now()-(${days}*interval '1 day') GROUP BY f.id,f.name ORDER BY count(*) DESC LIMIT 1),
          'templatesApproved',(SELECT count(*) FROM message_templates WHERE account_id=${context.accountId}::uuid AND status='APPROVED'),
          'templatesRejected',(SELECT count(*) FROM message_templates WHERE account_id=${context.accountId}::uuid AND status='REJECTED')),
        'latestBroadcast',(SELECT json_build_object('id',id,'name',name,'delivered',coalesce(delivered_count,0),'read',coalesce(read_count,0),'replied',coalesce(replied_count,0),'failed',coalesce(failed_count,0)) FROM broadcasts WHERE account_id=${context.accountId}::uuid ORDER BY created_at DESC LIMIT 1),
        'setup',json_build_object(
          'whatsapp',EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id=${context.accountId}::uuid AND phone_number_id IS NOT NULL),
          'contacts',EXISTS(SELECT 1 FROM contacts WHERE account_id=${context.accountId}::uuid),
          'template',EXISTS(SELECT 1 FROM message_templates WHERE account_id=${context.accountId}::uuid AND status='APPROVED'),
          'teammate',(SELECT count(*)>1 FROM account_memberships WHERE account_id=${context.accountId}::uuid),
          'conversation',EXISTS(SELECT 1 FROM conversations WHERE account_id=${context.accountId}::uuid))
      ) AS overview
    `);
    if (!rows[0]?.overview.replyTargetMinutes) throw new Error('Workspace unavailable');
    return rows[0].overview;
  });
}
