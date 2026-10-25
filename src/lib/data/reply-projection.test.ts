import { expect, it } from 'vitest';
import { validateQuery, validateWrite } from './contracts';
import { compileSelect } from '@/lib/repositories/query';
const tenant = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'owner' as const };
it('derives last real reply within the same tenant and conversation', () => {
  const spec = validateQuery('conversations', { projection: 'id,last_reply_at' }, tenant, true);
  const { text } = compileSelect(spec, tenant, true);
  expect(text).toContain('MAX(reply_message.created_at)');
  expect(text).toContain('reply_message.account_id = t.account_id');
  expect(text).toContain("reply_message.status IN ('sent','delivered','read')");
  expect(text).toContain("'template','system'");
  expect(() => validateWrite('conversations', { last_reply_at: new Date().toISOString() }, tenant, true, 'update')).toThrow(/cannot be changed/);
});
