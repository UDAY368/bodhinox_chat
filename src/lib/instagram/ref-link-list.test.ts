import { describe, expect, it } from 'vitest';
import { buildRefLinks, refsOfTrigger } from './ref-link-list';

const A1 = '44444444-4444-4444-8444-444444444444';
const A2 = '55555555-5555-4555-8555-555555555555';
const accounts = [{ id: A1, username: 'shop' }, { id: A2, username: null }];

describe('refsOfTrigger', () => {
  it('keeps valid, distinct keys and a well-formed account, and skips the rest', () => {
    expect(refsOfTrigger({ refs: ['a', 'a', 'b c', 7, 'ok_2'], instagram_account_id: A1.toUpperCase() }))
      .toEqual({ keys: ['a', 'ok_2'], instagramAccountId: A1 });
    expect(refsOfTrigger({ refs: 'a', instagram_account_id: 'nope' })).toEqual({ keys: [], instagramAccountId: null });
    expect(refsOfTrigger(null)).toEqual({ keys: [], instagramAccountId: null });
  });
});

describe('buildRefLinks', () => {
  it('lists one link per key and account, with no link for an account without a username', () => {
    const rows = buildRefLinks([{ id: 'f1', name: 'Sale', status: 'active', trigger_config: { refs: ['summer'] } }], accounts);
    expect(rows).toEqual([
      { flowId: 'f1', flowName: 'Sale', flowStatus: 'active', key: 'summer', instagramAccountId: A1, username: 'shop', url: 'https://ig.me/m/shop?ref=summer' },
      { flowId: 'f1', flowName: 'Sale', flowStatus: 'active', key: 'summer', instagramAccountId: A2, username: null, url: null },
    ]);
  });

  it('limits a flow tied to one account to that account, and skips archived flows', () => {
    const rows = buildRefLinks([
      { id: 'f1', name: 'Tied', status: 'draft', trigger_config: { refs: ['a', 'b'], instagram_account_id: A1 } },
      { id: 'f2', name: 'Gone', status: 'archived', trigger_config: { refs: ['c'] } },
      { id: 'f3', name: 'Elsewhere', status: 'active', trigger_config: { refs: ['d'], instagram_account_id: '99999999-9999-4999-8999-999999999999' } },
    ], accounts);
    expect(rows.map((r) => [r.flowId, r.key, r.instagramAccountId, r.flowStatus])).toEqual([['f1', 'a', A1, 'draft'], ['f1', 'b', A1, 'draft']]);
  });
});
