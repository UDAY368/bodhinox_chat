import { describe, expect, it } from 'vitest';
import { validateQuery, validateWrite } from './contracts';
import { compileSelect } from '@/lib/repositories/query';
import type { Filter } from './types';

const tenant = {
  accountId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'agent' as const,
};
describe('fixed CRM resource authorization', () => {
  it('exposes the latest customer timestamp as a tenant-scoped read-only conversation field', () => {
    const spec = validateQuery('conversations', { projection: 'id,last_customer_message_at' }, tenant, true);
    const sql = compileSelect(spec, tenant, true);
    expect(sql.text).toContain("sender_type = 'customer'");
    expect(sql.text).toContain('session_message.account_id = t.account_id');
    expect(() => validateWrite('conversations', { last_customer_message_at: '2026-10-19T12:00:00Z' }, tenant, true, 'update')).toThrow(/cannot be changed/);
  });
  it('requires validated routes for every browser automation and step mutation', () => {
    for (const resource of ['automations', 'automation_steps']) {
      const values =
        resource === 'automations'
          ? {
              name: 'Bypass attempt',
              trigger_type: 'scheduled',
              trigger_config: {},
              is_active: true,
            }
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
