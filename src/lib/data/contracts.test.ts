import { describe, expect, it } from 'vitest';
import { getResource, resourceBySlug, validateQuery, validateWrite } from './contracts';
import { compileSelect } from '@/lib/repositories/query';
import type { Filter } from './types';

const tenant = {
  accountId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'agent' as const,
};
describe('fixed CRM resource authorization', () => {
  it('permits invitation roles only when trusted admins create new invitations', () => {
    const owner = { ...tenant, role: 'owner' as const };
    for (const role of ['admin', 'agent', 'viewer']) {
      expect(() => validateWrite('account_invitations', { role }, owner)).not.toThrow();
      expect(() => validateWrite('account_invitations', { role }, owner, false, 'update')).toThrow();
      expect(() => validateWrite('account_invitations', { role }, owner, false, 'upsert')).toThrow();
      expect(() => validateWrite('account_invitations', { role }, owner, true)).toThrow();
      expect(() => validateWrite('account_invitations', { role }, tenant)).toThrow();
    }
    for (const role of ['owner', 'invalid', null]) {
      expect(() => validateWrite('account_invitations', { role }, owner)).toThrow();
    }
    expect(() => validateWrite('account_memberships', { role: 'admin' }, owner)).toThrow();
  });
  it('exposes the latest customer timestamp as a tenant-scoped read-only conversation field', () => {
    const spec = validateQuery('conversations', { projection: 'id,last_customer_message_at' }, tenant, true);
    const sql = compileSelect(spec, tenant, true);
    expect(sql.text).toContain("sender_type = 'customer'");
    expect(sql.text).toContain('session_message.account_id = t.account_id');
    expect(() => validateWrite('conversations', { last_customer_message_at: '2026-10-19T12:00:00Z' }, tenant, true, 'update')).toThrow(/cannot be changed/);
  });
  it('requires validated routes for every browser automation and step mutation', () => {
    for (const resource of ['automations', 'automation_steps', 'flows', 'flow_nodes']) {
      const values =
        resource === 'automations'
          ? {
              name: 'Bypass attempt',
              trigger_type: 'scheduled',
              trigger_config: {},
              is_active: true,
            }
          : resource === 'flows'
          ? { name: 'Bypass attempt', status: 'active' }
          : resource === 'flow_nodes'
          ? { node_key: 'n', node_type: 'api_request', config: {} }
          : {
              automation_id: tenant.accountId,
              step_type: 'send_message',
              step_config: {},
            };
      for (const operation of [
        'insert',
        'update',
        'upsert',
        'delete',
      ] as const) {
        const query = {
          operation,
          filters: [{ field: 'id', op: 'eq' as const, value: tenant.userId }],
          ...(operation === 'delete' ? {} : { values }),
        };
        for (const role of ['agent', 'owner'] as const) {
          expect(() =>
            validateQuery(resource, query, { ...tenant, role }, true)
          ).toThrow(/permission/i);
          expect(() =>
            validateQuery(resource, query, { ...tenant, role })
          ).not.toThrow();
        }
      }
      expect(() =>
        validateQuery(resource, { projection: '*' }, tenant, true)
      ).not.toThrow();
    }
  });
  it('keeps inbound creation markers internal to trusted worker writes and server reads', () => {
    for (const resource of ['contacts', 'conversations']) {
      const browserQuery = validateQuery(
        resource,
        { projection: '*' },
        tenant,
        true
      );
      expect(compileSelect(browserQuery, tenant, true).text).not.toContain(
        'inbound_created_meta_id'
      );
      expect(() =>
        compileSelect(
          validateQuery(
            resource,
            { projection: 'inbound_created_meta_id' },
            tenant,
            true
          ),
          tenant,
          true
        )
      ).toThrow();
      expect(() =>
        validateWrite(
          resource,
          { inbound_created_meta_id: 'wamid.INTERNAL' },
          tenant,
          true
        )
      ).toThrow();
      expect(() =>
        validateWrite(
          resource,
          { inbound_created_meta_id: 'wamid.INTERNAL' },
          tenant
        )
      ).toThrow();
      expect(
        compileSelect(
          validateQuery(
            resource,
            { projection: 'inbound_created_meta_id' },
            tenant
          ),
          tenant
        ).text
      ).toContain('inbound_created_meta_id');
    }
  });
  it('keeps messages readable but server-managed for browser writes so attribution cannot be forged', () => {
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const forged = { conversation_id: conversationId, sender_type: 'agent', sender_id: tenant.userId, content_type: 'text', content_text: 'x', status: 'sent', ai_generated: true };
    for (const role of ['agent', 'admin', 'owner'] as const) {
      const ctx = { ...tenant, role };
      expect(getResource('messages', true).browserWrite).toBe(false);
      for (const operation of ['insert', 'update', 'upsert'])
        expect(() => validateWrite('messages', operation === 'update' ? { sender_id: tenant.userId } : forged, ctx, true, operation)).toThrow(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
      for (const operation of ['insert', 'update', 'delete'] as const)
        expect(() => validateQuery('messages', { operation, values: operation === 'delete' ? undefined : (operation === 'update' ? { sender_type: 'bot' } : forged), filters: operation === 'insert' ? [] : [{ field: 'conversation_id', op: 'eq', value: conversationId }] }, ctx, true)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      expect(() => validateQuery('messages', { projection: 'id,sender_id,sender_type,ai_generated,status', filters: [{ field: 'conversation_id', op: 'eq', value: conversationId }] }, ctx, true)).not.toThrow();
    }
    // Server routes and workers (browser=false) still record sends.
    expect(() => validateWrite('messages', forged, tenant, false)).not.toThrow();
    expect(() => validateWrite('messages', { status: 'delivered' }, tenant, false, 'update')).not.toThrow();
    expect(() => validateQuery('messages', { operation: 'insert', values: forged, filters: [] }, tenant, false)).not.toThrow();
  });
  it('rejects forged HTTP timestamps and direct unread counter writes', () => {
    for (const field of ['created_at', 'updated_at'])
      expect(() =>
        validateWrite(
          'contacts',
          { name: 'Forged', [field]: '2000-01-01T00:00:00.000Z' },
          tenant,
          true
        )
      ).toThrow();
    expect(() =>
      validateWrite('conversations', { unread_count: 0 }, tenant, true)
    ).toThrow(/server-managed/);
    expect(() =>
      validateQuery(
        'contacts',
        {
          operation: 'insert',
          values: { inbound_created_meta_id: 'wamid.INTERNAL' },
          filters: [],
        },
        tenant,
        false,
        true
      )
    ).not.toThrow();
  });
  it('keeps a conversation number and the AI handoff stamps out of browser writes', () => {
    const id = [{ field: 'id', op: 'eq', value: '33333333-3333-4333-8333-333333333333' }] as Filter[];
    for (const [field, value] of [
      ['whatsapp_config_id', '44444444-4444-4444-8444-444444444444'],
      ['ai_handoff_at', null],
      ['ai_handoff_at', '2026-11-02T10:00:00.000Z'],
      ['ai_handoff_summary', 'Customer asked for a refund'],
    ] as const) {
      for (const operation of ['insert', 'update', 'upsert'])
        expect(() => validateWrite('conversations', { [field]: value }, tenant, true, operation)).toThrow(/server-managed/);
      expect(() =>
        validateQuery('conversations', { operation: 'update', values: { [field]: value }, filters: id }, tenant, true)
      ).toThrow(/server-managed/);
      // Server routes (auto-reply, inbound webhook) still write them.
      expect(() => validateWrite('conversations', { [field]: value }, tenant, false, 'update')).not.toThrow();
    }
    // Pausing the bot from the inbox stays a browser write.
    expect(() =>
      validateQuery('conversations', { operation: 'update', values: { bot_paused: false, ai_autoreply_disabled: false }, filters: id }, tenant, true)
    ).not.toThrow();
  });
  it('lets a browser only save campaign drafts and rename campaigns', () => {
    const id = [{ field: 'id', op: 'eq', value: '33333333-3333-4333-8333-333333333333' }] as Filter[];
    const draft = {
      user_id: tenant.userId,
      account_id: tenant.accountId,
      name: 'Diwali',
      template_name: 'utility_x',
      template_language: 'en_US',
      template_variables: { body: ['a'] },
      audience_filter: { type: 'all' },
      status: 'draft',
    };
    // broadcasts/new "Save draft".
    expect(() => validateQuery('broadcasts', { operation: 'insert', values: draft }, tenant, true)).not.toThrow();
    for (const status of ['scheduled', 'sending', 'completed'])
      expect(() => validateWrite('broadcasts', { ...draft, status }, tenant, true)).toThrow();
    for (const [field, value] of [
      ['kind', 'api'],
      ['whatsapp_config_id', '44444444-4444-4444-8444-444444444444'],
      ['scheduled_at', '2026-11-05T18:00:00.000Z'],
    ] as const)
      expect(() => validateWrite('broadcasts', { ...draft, [field]: value }, tenant, true)).toThrow(/server-managed/);
    // A saved campaign's sending fields cannot be edited from the browser.
    for (const [field, value] of [
      ['template_name', 'promo_x'],
      ['template_language', 'hi'],
      ['template_variables', { body: ['b'] }],
      ['whatsapp_config_id', '44444444-4444-4444-8444-444444444444'],
      ['scheduled_at', '2026-11-05T18:00:00.000Z'],
      ['audience_filter', { type: 'all' }],
      ['status', 'scheduled'],
      ['kind', 'api'],
    ] as const) {
      for (const operation of ['update', 'upsert'])
        expect(() => validateWrite('broadcasts', { [field]: value }, tenant, true, operation)).toThrow(/server-managed/);
      expect(() =>
        validateQuery('broadcasts', { operation: 'update', values: { [field]: value }, filters: id }, tenant, true)
      ).toThrow(/server-managed/);
    }
    expect(() =>
      validateQuery('broadcasts', { operation: 'update', values: { name: 'Renamed' }, filters: id }, tenant, true)
    ).not.toThrow();
    // Campaign routes write them server-side.
    expect(() =>
      validateWrite('broadcasts', { template_name: 'promo_x', scheduled_at: '2026-11-05T18:00:00.000Z', status: 'scheduled' }, tenant, false, 'update')
    ).not.toThrow();
    // An Instagram draft keeps its channel and text; a browser can never pause, or change them afterwards.
    expect(() =>
      validateQuery('broadcasts', { operation: 'insert', values: { ...draft, template_name: '', channel: 'instagram', message_text: 'Hi {first name}' } }, tenant, true)
    ).not.toThrow();
    expect(() => validateWrite('broadcasts', { ...draft, status: 'paused' }, tenant, true)).toThrow();
    expect(() => validateWrite('broadcasts', { ...draft, paused_at: '2026-11-05T18:00:00.000Z' }, tenant, true)).toThrow(/server-managed/);
    for (const [field, value] of [['channel', 'instagram'], ['message_text', 'changed'], ['paused_at', null], ['status', 'paused']] as const) {
      expect(() =>
        validateQuery('broadcasts', { operation: 'update', values: { [field]: value }, filters: id }, tenant, true)
      ).toThrow(/server-managed/);
    }
  });
  it('keeps the Stage 5 timed pause and Instagram subscription out of browser writes', () => {
    for (const operation of ['insert', 'update'] as const) {
      for (const [field, value] of [['bot_paused_until', '2026-11-20T10:00:00.000Z'], ['bot_paused_by', tenant.userId]] as const)
        expect(() => validateWrite('conversations', { [field]: value }, tenant, true, operation)).toThrow(/server-managed/);
      for (const field of ['instagram_opted_out_at', 'instagram_opted_in_at'])
        expect(() => validateWrite('contacts', { [field]: '2026-11-20T10:00:00.000Z' }, tenant, true, operation)).toThrow(/server-managed/);
    }
    // The server (routes and the flow engine) may still write them inside withTenant.
    expect(() => validateWrite('conversations', { bot_paused_until: '2026-11-20T10:00:00.000Z' }, tenant, false, 'update')).not.toThrow();
    expect(() => validateWrite('contacts', { instagram_opted_out_at: null }, tenant, false, 'update')).not.toThrow();
    // Browsers still read them (the inbox shows who paused and until when).
    expect(getResource('conversations', true).read).toEqual(expect.arrayContaining(['bot_paused_until', 'bot_paused_by']));
    expect(getResource('contacts', true).read).toEqual(expect.arrayContaining(['instagram_opted_out_at', 'instagram_opted_in_at']));
  });
  it('lets no browser claim or move who resolved a conversation, but shows it', () => {
    for (const operation of ['insert', 'update'] as const)
      expect(() => validateWrite('conversations', { resolved_by: tenant.userId }, tenant, true, operation)).toThrow(/server-managed/);
    expect(getResource('conversations', true).read).toContain('resolved_by');
  });
  it('keeps conversation lifecycle and SLA stamps out of browser writes while status stays writable', () => {
    for (const [field, value] of [
      ['lifecycle_state', 'resolved'],
      ['first_response_due_at', '2026-11-02T10:00:00.000Z'],
      ['first_responded_at', '2026-11-02T10:00:00.000Z'],
      ['resolved_at', '2026-11-02T10:00:00.000Z'],
      ['reopened_count', 0],
      ['reopened_at', '2026-11-02T10:00:00.000Z'],
    ] as const) {
      expect(() => validateWrite('conversations', { [field]: value }, tenant, true)).toThrow(/server-managed/);
      expect(() =>
        validateQuery('conversations', {
          operation: 'update',
          values: { status: 'closed', [field]: value },
          filters: [{ field: 'id', op: 'eq', value: '33333333-3333-4333-8333-333333333333' }],
        }, tenant, true)
      ).toThrow(/server-managed/);
    }
    // Resolve / reopen in the inbox writes status only; the lifecycle trigger moves the rest.
    for (const status of ['closed', 'open'])
      expect(() =>
        validateQuery('conversations', {
          operation: 'update',
          values: { status },
          filters: [{ field: 'id', op: 'eq', value: '33333333-3333-4333-8333-333333333333' }],
        }, tenant, true)
      ).not.toThrow();
    // The lifecycle columns stay readable.
    expect(getResource('conversations', true).read).toEqual(
      expect.arrayContaining(['lifecycle_state', 'first_response_due_at', 'first_responded_at', 'resolved_at', 'reopened_count', 'reopened_at'])
    );
  });
  it('lets a browser mark its notifications read but never choose their link or dedupe key', () => {
    expect(() => validateWrite('notifications', { read_at: '2026-11-02T10:00:00.000Z' }, tenant, true, 'update')).not.toThrow();
    for (const [field, value] of [['link', 'https://evil.example/'], ['link', '/inbox'], ['dedupe_key', 'sla_breach:x:0']] as const) {
      expect(() => validateWrite('notifications', { [field]: value }, tenant, true, 'update')).toThrow(/server-managed/);
      expect(() => validateWrite('notifications', { user_id: tenant.userId, type: 'mention', title: 'x', [field]: value }, tenant, true)).toThrow(/server-managed/);
    }
  });
  it('keeps a knowledge document\'s source, hash, fetch time and url server-managed for browsers', () => {
    expect(() => validateWrite('ai_knowledge_documents', { title: 'FAQ', content: 'Hours 9-5' }, tenant, true, 'update')).not.toThrow();
    for (const [field, value] of [
      ['source_id', '00000000-0000-4000-8000-000000000001'],
      ['content_hash', 'abc'],
      ['fetched_at', '2026-11-02T10:00:00.000Z'],
      ['source_url', 'https://evil.example/'],
    ] as const) {
      expect(() => validateWrite('ai_knowledge_documents', { [field]: value }, tenant, true, 'update')).toThrow(/server-managed/);
      expect(() => validateWrite('ai_knowledge_documents', { title: 'x', content: 'y', [field]: value }, tenant, true)).toThrow(/server-managed/);
      // Server routes (crawler, uploads) still set them.
      expect(() => validateWrite('ai_knowledge_documents', { [field]: value }, tenant, false, 'update')).not.toThrow();
    }
    // Still readable, so the UI can show where a document came from.
    expect(getResource('ai_knowledge_documents', true).read).toEqual(
      expect.arrayContaining(['source_id', 'content_hash', 'fetched_at', 'source_url'])
    );
  });
  it('keeps the Stage 2 Instagram columns out of browser writes', () => {
    const owner = { ...tenant, role: 'owner' as const };
    // The Instagram AI switch is readable like the WhatsApp one and written only by /api/ai/config.
    expect(getResource('ai_configs', true).read).toContain('instagram_auto_reply_enabled');
    expect(() => validateWrite('ai_configs', { instagram_auto_reply_enabled: true }, owner, true, 'update')).toThrow();
    // Webhook endpoints (and their channels) are server-only.
    expect(() => getResource('webhook_endpoints', true)).toThrow();
    expect(getResource('webhook_endpoints').columns.map((c) => c.name)).toContain('channels');
    // Instagram accounts, identities and comment events are not generic resources.
    for (const table of ['instagram_accounts', 'contact_channel_identities', 'instagram_comment_events', 'workspace_inbox_settings'])
      expect(() => getResource(table, true)).toThrow();
  });
  it('keeps the Stage 3 AI comment settings browser read-only and the approval queue off the generic API', () => {
    const owner = { ...tenant, role: 'owner' as const };
    // The switches are readable like the other AI settings; auto-approve is set only through a server route.
    for (const column of ['instagram_ai_comments_enabled', 'instagram_ai_comments_auto_approve', 'instagram_ai_comments_daily_cap']) {
      expect(getResource('ai_configs', true).read).toContain(column);
      expect(() => validateWrite('ai_configs', { [column]: true }, owner, true, 'update')).toThrow();
    }
    // Approvals go through the AI comment routes (role, CSRF, outbound intent), never the generic resource API.
    expect(() => getResource('instagram_ai_comment_queue', true)).toThrow();
    expect(() => getResource('instagram_ai_comment_queue')).toThrow();
    expect(() => resourceBySlug('instagram-ai-comment-queue')).toThrow();
  });
  it('keeps the Stage 4 reminders, scheduled replies and Page connection off the generic API', () => {
    // Reminders and scheduled replies are written through /api/inbox routes (role, CSRF, queue before acknowledgement,
    // outbound intent); the connection kind and Page id belong to instagram_accounts, which is not a resource either.
    for (const table of ['conversation_reminders', 'scheduled_replies', 'instagram_accounts']) {
      expect(() => getResource(table, true), table).toThrow();
      expect(() => getResource(table), table).toThrow();
    }
    expect(() => resourceBySlug('conversation-reminders')).toThrow();
    expect(() => resourceBySlug('scheduled-replies')).toThrow();
  });
  it('lets a browser read an automation channel but never set it; workspace_channels is not a resource', () => {
    expect(getResource('automations', true).read).toContain('channel');
    expect(() => validateQuery('automations', { projection: 'id,channel', filters: [{ field: 'channel', op: 'eq', value: 'instagram' }] }, tenant, true)).not.toThrow();
    const owner = { ...tenant, role: 'owner' as const };
    for (const operation of ['insert', 'update'] as const)
      expect(() => validateWrite('automations', { channel: 'instagram' }, owner, true, operation)).toThrow(/permission|server-managed/);
    // Trusted automation routes (non-browser) still set the channel on create.
    expect(() => validateWrite('automations', { name: 'Welcome', trigger_type: 'keyword_match', channel: 'instagram' }, owner)).not.toThrow();
    expect(() => getResource('workspace_channels', true)).toThrow();
    expect(() => getResource('workspace_channels')).toThrow();
    expect(() => resourceBySlug('workspace-channels')).toThrow();
  });
  it('exposes no Phase 5 inbox table through the generic browser resource API', () => {
    for (const table of [
      'conversation_notes',
      'routing_rules',
      'media_objects',
      'saved_filters',
      'notification_preferences',
      'notification_email_queue',
      'workspace_inbox_settings',
      'away_message_sends',
      'quick_reply_favourites',
      // Settings redesign: own quiet hours and language, browser push devices and queue.
      'member_preferences',
      'push_subscriptions',
      'notification_push_queue',
    ]) {
      expect(() => getResource(table, true)).toThrow();
      expect(() => getResource(table)).toThrow();
      expect(() => resourceBySlug(table.replaceAll('_', '-'))).toThrow();
      expect(() =>
        validateQuery(table, { operation: 'insert', values: { id: '33333333-3333-4333-8333-333333333333' } }, tenant, true)
      ).toThrow();
    }
  });
  it('rejects arbitrary resources and injected filter identifiers', () => {
    expect(() =>
      validateQuery('auth_users', { filters: [] }, tenant)
    ).toThrow();
    expect(() =>
      validateQuery(
        'contacts',
        {
          filters: [
            { field: 'id); DROP TABLE contacts;--', op: 'eq', value: 'x' },
          ],
        },
        tenant
      )
    ).toThrow();
  });
  it('rejects a different account and viewer mutations', () => {
    expect(() =>
      validateWrite(
        'contacts',
        { phone: '123', account_id: '33333333-3333-4333-8333-333333333333' },
        tenant
      )
    ).toThrow(/tenant/i);
    expect(() =>
      validateWrite('contacts', { phone: '123' }, { ...tenant, role: 'viewer' })
    ).toThrow(/permission/i);
  });
  it('rejects privilege fields and settings writes below admin', () => {
    expect(() =>
      validateWrite('profiles', { account_role: 'owner' }, tenant)
    ).toThrow();
    expect(() =>
      validateWrite('whatsapp_config', { access_token: 'secret' }, tenant)
    ).toThrow();
  });
  it('binds values and adds scope even for a lookup by id', () => {
    const spec = validateQuery(
      'contacts',
      {
        projection: 'id,name',
        filters: [
          {
            field: 'name',
            op: 'eq',
            value: "Robert'); DROP TABLE contacts;--",
          },
        ],
        limit: 20,
      },
      tenant
    );
    const sql = compileSelect(spec, tenant);
    expect(sql.text).toContain('"account_id"');
    expect(sql.text).not.toContain("Robert');");
    expect(sql.values).toContain("Robert'); DROP TABLE contacts;--");
    expect(sql.values).toContain(tenant.accountId);
  });
  it('allows validated nested contact/tag projections and bounded pagination', () => {
    const query = validateQuery(
      'contacts',
      { projection: '*,contact_tags(tags(*))', limit: 25 },
      tenant
    );
    expect(compileSelect(query, tenant).text).toContain('jsonb');
    expect(() =>
      validateQuery('contacts', { limit: 100001 }, tenant)
    ).toThrow();
  });
  it('masks all WhatsApp and AI secrets from browser wildcard projections', () => {
    for (const resource of ['whatsapp_config', 'ai_configs']) {
      const query = validateQuery(resource, { projection: '*' }, tenant, true);
      const sql = compileSelect(query, tenant, true);
      expect(sql.text).not.toMatch(
        /\."(access_token|verify_token|api_key|embeddings_api_key)"/
      );
    }
    expect(() =>
      compileSelect(
        validateQuery(
          'ai_configs',
          { projection: 'embeddings_api_key' },
          tenant,
          true
        ),
        tenant,
        true
      )
    ).toThrow();
  });
  it('denies editing another profile and identity-owned profile fields', () => {
    expect(() =>
      validateQuery(
        'profiles',
        {
          operation: 'update',
          values: { full_name: 'Spoof' },
          filters: [
            {
              field: 'id',
              op: 'eq',
              value: '33333333-3333-4333-8333-333333333333',
            },
          ],
        },
        tenant,
        true
      )
    ).toThrow(/current user/);
    expect(() =>
      validateWrite(
        'profiles',
        { email: 'spoof@example.invalid' },
        tenant,
        true
      )
    ).toThrow(/identity/);
  });
  it('rejects browser counter mutations and unexpected filter properties', () => {
    expect(() =>
      validateWrite('conversations', { unread_count: 0 }, tenant, true)
    ).toThrow(/server-managed/);
    expect(() =>
      validateQuery(
        'contacts',
        {
          filters: [
            {
              field: 'name',
              op: 'eq',
              value: 'a',
              sql: 'SELECT 1',
            } as unknown as Filter,
          ],
        },
        tenant,
        true
      )
    ).toThrow(/Unexpected/);
  });
  it('only permits the declared flow-event JSON filter key', () => {
    const query = validateQuery(
      'flow_run_events',
      {
        filters: [
          { field: 'payload->>meta_message_id', op: 'eq', value: 'wamid123' },
        ],
      },
      tenant
    );
    const sql = compileSelect(query, tenant);
    expect(sql.text).toContain('->>');
    expect(sql.values).toContain('meta_message_id');
    expect(sql.values).toContain('wamid123');
    expect(() =>
      validateQuery(
        'flow_run_events',
        {
          filters: [
            { field: 'payload->>arbitrary_secret', op: 'eq', value: 'x' },
          ],
        },
        tenant
      )
    ).toThrow();
    expect(() =>
      validateQuery(
        'flow_run_events',
        {
          filters: [
            { field: "payload->>id'); SELECT 1;--", op: 'eq', value: 'x' },
          ],
        },
        tenant
      )
    ).toThrow();
  });
});
