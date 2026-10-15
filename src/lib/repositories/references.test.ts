import { expect, it } from 'vitest';
import { validateReferences, type SqlTransaction } from './crm';
const context = {
  accountId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'owner' as const,
};
const foreign = '33333333-3333-4333-8333-333333333333';
// No referenced row/member is visible under this tenant transaction.
const empty: SqlTransaction = { $queryRawUnsafe: async <T>() => [] as T };
it('rejects cross-tenant conversation assignment even without an upstream FK', async () => {
  await expect(
    validateReferences(
      empty,
      {
        resource: 'conversations',
        operation: 'update',
        filters: [],
        values: { assigned_agent_id: foreign },
      },
      context
    )
  ).rejects.toMatchObject({ code: 'RELATED_RECORD_FORBIDDEN' });
});
it('checks IDs inside automation/flow configs before they are persisted', async () => {
  await expect(
    validateReferences(
      empty,
      {
        resource: 'automation_steps',
        operation: 'insert',
        filters: [],
        values: { step_config: { tag_id: foreign } },
      },
      context
    )
  ).rejects.toMatchObject({ code: 'RELATED_RECORD_FORBIDDEN' });
  await expect(
    validateReferences(
      empty,
      {
        resource: 'flow_nodes',
        operation: 'insert',
        filters: [],
        values: { config: { assign_to: foreign } },
      },
      context
    )
  ).rejects.toMatchObject({ code: 'RELATED_RECORD_FORBIDDEN' });
});
it('preserves trusted worker historical authors while keeping assignment membership checks', async () => {
  await expect(
    validateReferences(
      empty,
      {
        resource: 'contacts',
        operation: 'insert',
        filters: [],
        values: { user_id: foreign, phone: '123' },
      },
      context,
      true
    )
  ).resolves.toBeUndefined();
  await expect(
    validateReferences(
      empty,
      {
        resource: 'contacts',
        operation: 'insert',
        filters: [],
        values: { user_id: foreign, phone: '123' },
      },
      context
    )
  ).rejects.toMatchObject({ code: 'RELATED_RECORD_FORBIDDEN' });
  await expect(
    validateReferences(
      empty,
      {
        resource: 'conversations',
        operation: 'update',
        filters: [],
        values: { assigned_agent_id: foreign },
      },
      context,
      true
    )
  ).rejects.toMatchObject({ code: 'RELATED_RECORD_FORBIDDEN' });
});
it('permits newly inserted nested steps only within the same automation', async () => {
  const root = '44444444-4444-4444-8444-444444444444';
  const tx: SqlTransaction = {
    $queryRawUnsafe: async <T>(sql: string) =>
      (sql.includes('FROM "automations"') ? [{}] : []) as T,
  };
  const query = {
    resource: 'automation_steps',
    operation: 'insert' as const,
    filters: [],
    values: [
      { id: root, automation_id: foreign, parent_step_id: null },
      { id: context.userId, automation_id: foreign, parent_step_id: root },
    ],
  };
  await expect(validateReferences(tx, query, context)).resolves.toBeUndefined();
  query.values[1].automation_id = context.accountId;
  await expect(validateReferences(tx, query, context)).rejects.toMatchObject({
    code: 'RELATED_RECORD_FORBIDDEN',
  });
});
