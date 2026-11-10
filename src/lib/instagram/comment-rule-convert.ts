// "Convert to flow" for a legacy Instagram comment rule (Stage 2, 2E; owner
// decision 1: migrate). Turns one instagram_comment_rules row into an
// equivalent draft Instagram flow and switches the rule off, in one member
// transaction, so a comment is never answered by both. The flow stays a draft
// until someone publishes it (the UI says so).
//
// Equivalence:
//   rule.media_id        -> trigger post_scope 'specific' with media_ids [id], else 'any'
//   rule.keywords        -> include_keywords, include_mode 'contains' (the rule matched
//                           lower-cased substrings; empty matches every comment)
//   rule.reply_text      -> one ig_private_reply step (no "Opening DM" button), then end
//   rule.instagram_account_id -> trigger_config.instagram_account_id
// One difference: an ig_comment flow answers a person's first comment per
// post, where the rule answered every comment (each still got one reply).
//
// Admin only, like the rules. Runs as the member (app role, RLS) inside
// withTenant; no Instagram call.
import { hasMinRole } from '@/lib/auth/roles';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { IgCommentTriggerConfig, IgPrivateReplyNodeConfig } from '@/lib/flows/types';
import { getT } from '@/lib/i18n/translate';
import { auditTx } from '@/lib/payments/ledger';
import { instagramConfig } from './config';
import type { InstagramActor } from './connection';
import { InstagramError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 120;

export interface LegacyCommentRule {
  instagramAccountId: string;
  mediaId: string | null;
  keywords: string[];
  replyText: string;
}

export interface CommentFlowDraft {
  name: string;
  trigger_type: 'ig_comment';
  trigger_config: IgCommentTriggerConfig;
  entry_node_id: string;
  nodes: Array<{ node_key: string; node_type: 'start' | 'ig_private_reply' | 'end'; config: Record<string, unknown>; position_y: number }>;
}

/** The draft flow a rule converts to. Pure. */
export function commentRuleFlowDraft(rule: LegacyCommentRule): CommentFlowDraft {
  const label = rule.keywords.slice(0, 3).join(', ') || getT('Settings.instagram.commentRules')('keywordsAny');
  const name = [...`${getT('Instagram.comments')('title')} · ${label}`].slice(0, NAME_MAX).join('');
  const trigger_config: IgCommentTriggerConfig = {
    instagram_account_id: rule.instagramAccountId,
    post_scope: rule.mediaId ? 'specific' : 'any',
    ...(rule.mediaId ? { media_ids: [rule.mediaId] } : {}),
    include_keywords: [...rule.keywords],
    include_mode: 'contains',
  };
  const reply: IgPrivateReplyNodeConfig = { text: rule.replyText, next_node_key: 'end' };
  return {
    name,
    trigger_type: 'ig_comment',
    trigger_config,
    entry_node_id: 'start',
    nodes: [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'private_reply' }, position_y: 0 },
      { node_key: 'private_reply', node_type: 'ig_private_reply', config: { ...reply }, position_y: 160 },
      { node_key: 'end', node_type: 'end', config: {}, position_y: 320 },
    ],
  };
}

interface RuleRow { media_id: string | null; keywords: string[]; reply_text: string }

async function lockRuleTx(tx: TenantTransaction, accountId: string, instagramAccountId: string, ruleId: string) {
  const [rule] = await tx.$queryRaw<RuleRow[]>`SELECT media_id, keywords, reply_text FROM instagram_comment_rules
    WHERE account_id=${accountId}::uuid AND instagram_account_id=${instagramAccountId}::uuid AND id=${ruleId}::uuid FOR UPDATE`;
  return rule ?? null;
}

/**
 * Admin: create the equivalent draft Instagram flow and turn the rule off,
 * atomically. Off -> instagram_not_enabled; not an admin -> forbidden; plan
 * without Instagram -> PlanLimitError; unknown or other-workspace account or
 * rule -> not_found. The account may be disconnected or lack the comments
 * permission: the flow can be built before reconnecting.
 */
export async function convertCommentRuleToFlow(actor: InstagramActor, instagramAccountId: string,
  ruleId: string): Promise<{ flowId: string }> {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new InstagramError('forbidden');
  if (!UUID.test(instagramAccountId) || !UUID.test(ruleId)) throw new InstagramError('not_found');
  return withTenant(actor, async (tx) => {
    await requireFeature(tx, actor.accountId, 'instagram');
    const rule = await lockRuleTx(tx, actor.accountId, instagramAccountId, ruleId);
    if (!rule) throw new InstagramError('not_found');
    const draft = commentRuleFlowDraft({
      instagramAccountId, mediaId: rule.media_id, keywords: [...(rule.keywords ?? [])], replyText: rule.reply_text,
    });
    const [flow] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO flows(user_id, account_id, name, status, trigger_type, trigger_config, entry_node_id, channel_scope)
      VALUES(${actor.userId}::uuid, ${actor.accountId}::uuid, ${draft.name}, 'draft', ${draft.trigger_type},
        ${JSON.stringify(draft.trigger_config)}::jsonb, ${draft.entry_node_id}, 'instagram')
      RETURNING id::text AS id`;
    for (const node of draft.nodes) {
      await tx.$executeRaw`INSERT INTO flow_nodes(account_id, flow_id, node_key, node_type, config, position_x, position_y)
        VALUES(${actor.accountId}::uuid, ${flow.id}::uuid, ${node.node_key}, ${node.node_type}, ${JSON.stringify(node.config)}::jsonb,
          0, ${node.position_y})`;
    }
    await tx.$executeRaw`UPDATE instagram_comment_rules SET active=false
      WHERE account_id=${actor.accountId}::uuid AND instagram_account_id=${instagramAccountId}::uuid AND id=${ruleId}::uuid`;
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.comment_rule.convert', ruleId,
      { instagram_account_id: instagramAccountId, flow_id: flow.id });
    return { flowId: flow.id };
  });
}
