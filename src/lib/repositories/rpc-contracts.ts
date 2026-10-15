import {
  ContractError,
  validateTenant,
  validateValue,
} from '@/lib/data/contracts';
import type { Row, TenantContext } from '@/lib/data/types';
export interface RpcContract {
  slug: string;
  args: Record<string, { type: string; default?: unknown }>;
  scalar?: boolean;
  returnsVoid?: boolean;
  read?: boolean;
  browser?: boolean;
  minRole?: 'agent' | 'admin' | 'owner';
}
const argument = (type: string, defaultValue?: unknown) => ({
  type,
  ...(defaultValue !== undefined ? { default: defaultValue } : {}),
});
export const rpcContracts: Record<string, RpcContract> = {
  mark_conversation_read: {
    slug: 'conversation-mark-read',
    browser: true,
    returnsVoid: true,
    args: { p_conversation_id: argument('uuid') },
  },
  set_media_retention: {
    slug: 'media-retention',
    browser: true,
    returnsVoid: true,
    minRole: 'admin',
    args: { p_enabled: argument('boolean') },
  },
  filter_contacts_by_tags: {
    slug: 'contacts-by-tags',
    read: true,
    browser: true,
    args: {
      p_tag_ids: argument('uuid[]'),
      p_search: argument('text', null),
      p_limit: argument('integer', 25),
      p_offset: argument('integer', 0),
    },
  },
  touch_presence: {
    slug: 'presence-heartbeat',
    browser: true,
    returnsVoid: true,
    args: { p_status: argument('text', 'online') },
  },
  increment_automation_execution_count: {
    slug: 'automation-counter',
    returnsVoid: true,
    args: { p_automation_id: argument('uuid') },
  },
  increment_flow_execution_count: {
    slug: 'flow-counter',
    returnsVoid: true,
    args: { p_flow_id: argument('uuid') },
  },
  claim_ai_reply_slot: {
    slug: 'ai-reply-slot',
    scalar: true,
    args: {
      conversation_id: argument('uuid'),
      max_replies: argument('integer'),
    },
  },
  bump_conversation_on_inbound: {
    slug: 'inbound-conversation',
    returnsVoid: true,
    args: {
      p_conversation_id: argument('uuid'),
      p_last_message_text: argument('text'),
    },
  },
  create_broadcast_with_recipients: {
    slug: 'broadcast-create',
    args: {
      p_account_id: argument('uuid'),
      p_user_id: argument('uuid'),
      p_name: argument('text'),
      p_template_name: argument('text'),
      p_template_language: argument('text'),
      p_total_recipients: argument('integer'),
      p_contact_ids: argument('uuid[]'),
      p_template_params: argument('jsonb[]', null),
    },
  },
  match_ai_knowledge_fts: {
    slug: 'knowledge-text',
    read: true,
    args: {
      p_account_id: argument('uuid'),
      p_query: argument('text'),
      p_match_count: argument('integer'),
    },
  },
  match_ai_knowledge_semantic: {
    slug: 'knowledge-semantic',
    read: true,
    args: {
      p_account_id: argument('uuid'),
      p_query_embedding: argument('text'),
      p_match_count: argument('integer'),
    },
  },
  record_webhook_failure: {
    slug: 'webhook-failure',
    returnsVoid: true,
    minRole: 'admin',
    args: { endpoint_id: argument('uuid'), max_failures: argument('integer') },
  },
  recompute_broadcast_counts: {
    slug: 'broadcast-counts',
    returnsVoid: true,
    args: { bid: argument('uuid') },
  },
};
export function validateRpc(
  name: string,
  args: Row,
  context: TenantContext,
  browser = false
): { contract: RpcContract; args: Row } {
  validateTenant(context);
  const contract = Object.hasOwn(rpcContracts, name)
    ? rpcContracts[name]
    : undefined;
  if (!contract || (browser && !contract.browser))
    throw new ContractError(
      'Unsupported CRM operation',
      'UNSUPPORTED_RPC',
      404
    );
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new ContractError('Invalid operation arguments');
  if (
    Object.keys(args).some(
      (key) =>
        !Object.hasOwn(contract.args, key) &&
        key !== 'p_account_id' &&
        key !== 'account_id'
    )
  )
    throw new ContractError('Unexpected operation argument');
  if (
    (args.p_account_id !== undefined &&
      args.p_account_id !== context.accountId) ||
    (args.account_id !== undefined && args.account_id !== context.accountId)
  )
    throw new ContractError(
      'Cross-tenant operation rejected',
      'TENANT_MISMATCH',
      403
    );
  const rank = { viewer: 0, agent: 1, admin: 2, owner: 3 };
  if (
    !contract.read &&
    name !== 'touch_presence' &&
    (!context.role || rank[context.role] < rank[contract.minRole ?? 'agent'])
  )
    throw new ContractError(
      'Insufficient operation permission',
      'FORBIDDEN',
      403
    );
  const resolved: Row = {};
  for (const [key, column] of Object.entries(contract.args)) {
    const value = args[key] ?? column.default;
    if (value === undefined) throw new ContractError(`Missing argument ${key}`);
    validateValue({ name: key, type: column.type }, value);
    if (column.type === 'uuid[]' && value !== null)
      (value as unknown[]).forEach((v) =>
        validateValue({ name: key, type: 'uuid' }, v)
      );
    if (
      column.type === 'integer' &&
      (!Number.isInteger(value) ||
        Number(value) < 0 ||
        Number(value) > (key === 'p_offset' ? 1000000 : 100000))
    )
      throw new ContractError('Operation number out of bounds');
    resolved[key] = value;
  }
  if (
    name === 'touch_presence' &&
    !['online', 'away'].includes(resolved.p_status)
  )
    throw new ContractError('Invalid presence state');
  return { contract, args: resolved };
}
