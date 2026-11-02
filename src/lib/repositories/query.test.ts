import { describe, expect, it } from 'vitest';
import { compileMutation } from './query';

const context = { accountId: '00000000-0000-0000-0000-000000000001', userId: '00000000-0000-0000-0000-000000000002', role: 'admin' } as never;

describe('compileMutation', () => {
  it('binds null as SQL NULL for jsonb columns, not the JSON value null', () => {
    const q = compileMutation({ resource: 'message_templates', operation: 'insert', values: { name: 'x', body_text: 'b', cards: null, buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }, filters: [] } as never, context);
    const values = (q as { values: unknown[] }).values;
    expect(values).toContain(null);
    expect(values).not.toContain('null');
    expect(values).toContain(JSON.stringify([{ type: 'QUICK_REPLY', text: 'Yes' }]));
  });
});
