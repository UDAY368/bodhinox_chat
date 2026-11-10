// Stage 2 (2E): conversation starters and rule conversion, pure parts. The
// database paths (tenancy, the Meta sync, the one-transaction conversion) are
// in tools.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { channelScopeIssues } from '@/lib/flows/validate';
import { commentRuleFlowDraft } from './comment-rule-convert';
import { InstagramError } from './errors';
import { iceBreakersFit } from './graph-limits';
import { iceBreakerItems, MAX_STARTERS, normaliseStarters, storedStarters } from './ice-breakers';
import { decodePostback } from './postback-payloads';

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const IG = '44444444-4444-4444-8444-444444444444';
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error instanceof InstagramError ? error.code : String(error);
  }
};

describe('normaliseStarters', () => {
  it('trims questions, collapses spaces and lower-cases flow ids', () => {
    expect(normaliseStarters([{ question: '  Opening   hours? ', flowId: F1.toUpperCase() }]))
      .toEqual([{ question: 'Opening hours?', flowId: F1 }]);
  });

  it('allows an empty list (removes the starters)', () => {
    expect(normaliseStarters([])).toEqual([]);
  });

  it('refuses more than 4, an empty, over-long or repeated question, or a bad flow id', () => {
    const four = Array.from({ length: MAX_STARTERS + 1 }, (_, i) => ({ question: `Q${i}`, flowId: F1 }));
    expect(codeOf(() => normaliseStarters(four))).toBe('invalid_request');
    expect(codeOf(() => normaliseStarters([{ question: '   ', flowId: F1 }]))).toBe('invalid_request');
    expect(codeOf(() => normaliseStarters([{ question: 'x'.repeat(81), flowId: F1 }]))).toBe('invalid_request');
    expect(codeOf(() => normaliseStarters([{ question: 'Price?', flowId: F1 }, { question: ' price? ', flowId: F2 }])))
      .toBe('invalid_request');
    expect(codeOf(() => normaliseStarters([{ question: 'Price?', flowId: 'not-a-uuid' }]))).toBe('invalid_request');
  });

  it('counts an emoji as one character, as Meta does', () => {
    expect(codeOf(() => normaliseStarters([{ question: '🙂'.repeat(80), flowId: F1 }]))).toBe('ok');
  });
});

describe('storedStarters', () => {
  it('reads the stored list and skips anything malformed', () => {
    expect(storedStarters([
      { question: 'Hours?', flow_id: F1 },
      { question: '', flow_id: F2 },
      { question: 'Bad', flow_id: 'x' },
      null,
      'nope',
    ])).toEqual([{ question: 'Hours?', flowId: F1 }]);
    expect(storedStarters(null)).toEqual([]);
    expect(storedStarters({})).toEqual([]);
  });
});

describe('iceBreakerItems', () => {
  it('posts back ib:<flow id>, which decodes to the starter flow and fits Meta limits', () => {
    const items = iceBreakerItems(normaliseStarters([{ question: 'Hours?', flowId: F1 }, { question: 'Prices?', flowId: F2 }]));
    expect(items).toEqual([{ question: 'Hours?', payload: `ib:${F1}` }, { question: 'Prices?', payload: `ib:${F2}` }]);
    expect(items.map((i) => decodePostback(i.payload))).toEqual([
      { kind: 'ice_breaker', flowId: F1 }, { kind: 'ice_breaker', flowId: F2 },
    ]);
    expect(iceBreakersFit(items)).toBe(true);
  });
});

describe('commentRuleFlowDraft', () => {
  it('maps a post rule to a specific-post comment flow with one private reply', () => {
    const draft = commentRuleFlowDraft({ instagramAccountId: IG, mediaId: '17890001', keywords: ['price', 'link'], replyText: 'Here it is' });
    expect(draft.trigger_type).toBe('ig_comment');
    expect(draft.trigger_config).toEqual({
      instagram_account_id: IG, post_scope: 'specific', media_ids: ['17890001'], include_keywords: ['price', 'link'], include_mode: 'contains',
    });
    expect(draft.entry_node_id).toBe('start');
    expect(draft.nodes.map((n) => [n.node_key, n.node_type, n.config])).toEqual([
      ['start', 'start', { next_node_key: 'private_reply' }],
      ['private_reply', 'ig_private_reply', { text: 'Here it is', next_node_key: 'end' }],
      ['end', 'end', {}],
    ]);
    expect(draft.name).toContain('price, link');
  });

  it('maps an any-post rule without keywords to any post and any comment', () => {
    const draft = commentRuleFlowDraft({ instagramAccountId: IG, mediaId: null, keywords: [], replyText: 'Hi' });
    expect(draft.trigger_config).toEqual({ instagram_account_id: IG, post_scope: 'any', include_keywords: [], include_mode: 'contains' });
    expect(draft.name.length).toBeGreaterThan(0);
  });

  it('is a valid Instagram flow and not a WhatsApp one', () => {
    const draft = commentRuleFlowDraft({ instagramAccountId: IG, mediaId: null, keywords: ['x'], replyText: 'Hi' });
    expect(channelScopeIssues('instagram', draft.trigger_type, draft.nodes)).toEqual([]);
    expect(channelScopeIssues('whatsapp', draft.trigger_type, draft.nodes).length).toBeGreaterThan(0);
  });
});
