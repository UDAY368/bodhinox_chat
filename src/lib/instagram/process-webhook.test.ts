import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  ingest: vi.fn(),
  findExistingContact: vi.fn(),
  pickBestPhoneMatch: vi.fn(),
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: h.queryRaw, $executeRaw: h.executeRaw,
    $transaction: (work: (tx: unknown) => unknown) => work({ $queryRaw: h.queryRaw, $executeRaw: h.executeRaw }),
  }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_ctx: unknown, work: (tx: unknown) => unknown) => work({ $queryRaw: h.queryRaw, $executeRaw: h.executeRaw }),
}));
vi.mock('@/lib/jobs/scope', () => ({ withJobScope: (_ctx: unknown, work: () => unknown) => work() }));
vi.mock('@/lib/billing/entitlements', () => ({ getEntitlements: vi.fn(async () => ({ features: { instagram: true }, limits: {} })) }));
vi.mock('@/lib/whatsapp/ingest', () => ({ ingestInboundMessage: h.ingest }));
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: h.findExistingContact, pickBestPhoneMatch: h.pickBestPhoneMatch }));

import {
  isEmojiOnly,
  matchCommentRule,
  parseCommentChange,
  parseMessagingEvent,
  processInstagramWebhookJob,
} from './process-webhook';

const ACCOUNT_IG = '17840000000001';
const NOW = new Date('2026-11-04T10:00:00Z');
const RECEIPT = '11111111-1111-4111-8111-111111111111';
const env = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 's',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'v', APP_URL: 'https://app.example.test',
};
const msg = (message: Record<string, unknown>, sender = '9001', recipient = ACCOUNT_IG) =>
  ({ sender: { id: sender }, recipient: { id: recipient }, timestamp: NOW.getTime() - 1000, message });

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
});
afterEach(() => vi.unstubAllEnvs());

describe('parseMessagingEvent', () => {
  it('parses a customer text message', () => {
    const event = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm1', text: 'hello' }), NOW);
    expect(event).toMatchObject({ kind: 'message', igsid: '9001', replyToMid: null,
      items: [{ messageId: 'm1', contentType: 'text', text: 'hello', mediaUrl: null }] });
    expect((event as { createdAt: Date }).createdAt.getTime()).toBe(NOW.getTime() - 1000);
  });

  it('maps attachments, and an unknown attachment to unsupported', () => {
    const event = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm2', attachments: [
      { type: 'image', payload: { url: 'https://cdn.example/a.jpg' } },
      { type: 'file', payload: { url: 'https://cdn.example/a.pdf' } },
      { type: 'ig_reel', payload: { url: 'https://cdn.example/reel' } },
      { type: 'sticker_pack', payload: { url: 'https://cdn.example/s' } },
      { type: 'image', payload: { url: 'javascript:alert(1)' } },
    ] }), NOW);
    if (event.kind !== 'message') throw new Error('expected a message');
    expect(event.items.map((i) => [i.messageId, i.contentType, i.mediaUrl])).toEqual([
      ['m2', 'image', 'https://cdn.example/a.jpg'],
      ['m2#1', 'document', 'https://cdn.example/a.pdf'],
      ['m2#2', 'share', null],
      ['m2#3', 'unsupported', null],
      ['m2#4', 'unsupported', null],
    ]);
    expect(event.items[2].ig).toEqual({ url: 'https://cdn.example/reel' });
    expect(event.items[3].ig).toEqual({ type: 'sticker_pack' });
  });

  it('parses story replies, quick replies and Meta-flagged unsupported messages', () => {
    const story = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm3', text: 'nice', reply_to: { story: { id: '1', url: 'https://cdn.example/story' } } }), NOW);
    expect(story).toMatchObject({ kind: 'message', items: [{ contentType: 'story_reply', text: 'nice', ig: { story: true, url: 'https://cdn.example/story' } }] });
    const quick = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm4', text: 'Yes', quick_reply: { payload: 'YES' } }), NOW);
    expect(quick).toMatchObject({ items: [{ contentType: 'interactive', interactiveReplyId: 'YES', text: 'Yes' }] });
    const unsupported = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm5', is_unsupported: true }), NOW);
    expect(unsupported).toMatchObject({ items: [{ contentType: 'unsupported' }] });
    const reply = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm6', text: 'x', reply_to: { mid: 'm1' } }), NOW);
    expect(reply).toMatchObject({ kind: 'message', replyToMid: 'm1' });
  });

  it('parses a postback as an interactive reply', () => {
    const event = parseMessagingEvent(ACCOUNT_IG, {
      sender: { id: '9001' }, recipient: { id: ACCOUNT_IG }, timestamp: NOW.getTime(),
      postback: { mid: 'pb1', title: 'Get started', payload: 'START' },
    }, NOW);
    expect(event).toMatchObject({ kind: 'message', items: [{ messageId: 'pb1', contentType: 'interactive',
      interactiveReplyId: 'START', text: 'Get started', ig: { postback: { title: 'Get started' } } }] });
  });

  it('treats an echo as an agent-side message to the recipient, marked external', () => {
    const echo = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm7', text: 'sent from the app', is_echo: true }, ACCOUNT_IG, '9001'), NOW);
    expect(echo).toMatchObject({ kind: 'echo', igsid: '9001', items: [{ messageId: 'm7', ig: { external_echo: true } }] });
    // An echo by sender id alone (no is_echo flag) is still an echo.
    expect(parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm8', text: 'x' }, ACCOUNT_IG, '9001'), NOW).kind).toBe('echo');
  });

  it('counts reactions, read receipts, deletions and unknown events as unsupported', () => {
    const base = { sender: { id: '9001' }, recipient: { id: ACCOUNT_IG }, timestamp: 1 };
    expect(parseMessagingEvent(ACCOUNT_IG, { ...base, reaction: { mid: 'm1', action: 'react', reaction: 'love' } }).kind).toBe('unsupported');
    expect(parseMessagingEvent(ACCOUNT_IG, { ...base, read: { mid: 'm1' } }).kind).toBe('unsupported');
    expect(parseMessagingEvent(ACCOUNT_IG, { ...base, referral: { ref: 'x' } }).kind).toBe('unsupported');
    expect(parseMessagingEvent(ACCOUNT_IG, { ...base, message: { mid: 'm1', is_deleted: true } }).kind).toBe('unsupported');
  });

  it('ignores malformed events', () => {
    expect(parseMessagingEvent(ACCOUNT_IG, null).kind).toBe('ignored');
    expect(parseMessagingEvent(ACCOUNT_IG, msg({ text: 'no mid' })).kind).toBe('ignored');
    expect(parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'm1', text: 'x' }, 'not-a-number')).kind).toBe('ignored');
    expect(parseMessagingEvent(ACCOUNT_IG, msg({ mid: 'bad mid with spaces', text: 'x' })).kind).toBe('ignored');
  });

  it('uses now for an implausible or future timestamp', () => {
    const event = parseMessagingEvent(ACCOUNT_IG, { ...msg({ mid: 'm1', text: 'x' }), timestamp: NOW.getTime() + 3_600_000 }, NOW);
    expect((event as { createdAt: Date }).createdAt).toEqual(NOW);
  });
});

describe('comments', () => {
  it('parses a comments change and counts other fields as unsupported', () => {
    expect(parseCommentChange({ field: 'comments', value: { id: '555', text: 'Price?', media: { id: '777' }, from: { id: '9001', username: 'u' } } }))
      .toEqual({ commentId: '555', mediaId: '777', fromIgsid: '9001', text: 'Price?' });
    expect(parseCommentChange({ field: 'mentions', value: {} })).toBe('unsupported');
    expect(parseCommentChange({ field: 'live_comments', value: {} })).toBe('unsupported');
    expect(parseCommentChange({ field: 'comments', value: { id: 'x' } })).toBeNull();
  });

  it('matches a post rule before an any-post rule, by lower-cased keyword', () => {
    const rules = [
      { id: 'any', media_id: null, keywords: ['price'] },
      { id: 'post', media_id: '777', keywords: ['PRICE'] },
      { id: 'other', media_id: '888', keywords: [] },
    ];
    expect(matchCommentRule(rules, { mediaId: '777', text: 'What is the Price?' })?.id).toBe('post');
    expect(matchCommentRule(rules, { mediaId: '999', text: 'price please' })?.id).toBe('any');
    expect(matchCommentRule(rules, { mediaId: '888', text: 'anything' })?.id).toBe('other');
    expect(matchCommentRule(rules, { mediaId: '999', text: 'hello' })).toBeNull();
  });
});

describe('processInstagramWebhookJob', () => {
  it('marks the receipt skipped_disabled and reads nothing while Instagram is off', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    h.executeRaw.mockResolvedValue(1);
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    expect(h.executeRaw.mock.calls[0].slice(1)).toContain('skipped_disabled');
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('refuses an invalid receipt id', async () => {
    await expect(processInstagramWebhookJob({ receiptId: 'x' })).rejects.toThrow('Invalid job identifier');
  });

  it('drops entries for an unconnected account without writing, and logs no ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.queryRaw
      .mockResolvedValueOnce([{ status: 'received', payload: { object: 'instagram', entry: [{ id: ACCOUNT_IG, messaging: [msg({ mid: 'm1', text: 'hi' })] }] } }])
      .mockResolvedValueOnce([]); // crm_resolve_instagram_account: unknown
    h.executeRaw.mockResolvedValue(1);
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.executeRaw).toHaveBeenCalledTimes(1); // receipt -> processed only
    expect(h.executeRaw.mock.calls[0].slice(1)).toContain('processed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ACCOUNT_IG);
    warn.mockRestore();
  });

  it('creates a new phone-less contact for a new IGSID and never runs phone dedupe', async () => {
    const accountId = '22222222-2222-4222-8222-222222222222';
    const igAccountId = '33333333-3333-4333-8333-333333333333';
    const userId = '44444444-4444-4444-8444-444444444444';
    const contactId = '55555555-5555-4555-8555-555555555555';
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM webhook_receipts'))
        return [{ status: 'received', payload: { object: 'instagram', entry: [{ id: ACCOUNT_IG, messaging: [msg({ mid: 'm1', text: 'hi' })] }] } }];
      if (sql.includes('crm_resolve_instagram_account')) return [{ account_id: accountId, instagram_account_id: igAccountId }];
      if (sql.includes('FROM instagram_accounts a JOIN accounts'))
        return [{ scopes: ['instagram_business_basic', 'instagram_business_manage_messages'], connected_by_user_id: userId, owner_user_id: userId }];
      if (sql.includes('FROM contact_channel_identities')) return [];
      if (sql.includes('INSERT INTO contacts')) return [{ id: contactId }];
      if (sql.includes('INSERT INTO contact_channel_identities')) return [{ id: 'ident-1', contact_id: contactId }];
      if (sql.includes('FROM conversations')) return [];
      if (sql.includes('INSERT INTO conversations')) return [{ id: 'conv-1' }];
      throw new Error(`unexpected query: ${sql}`);
    });
    h.executeRaw.mockResolvedValue(1);
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    const contactInsert = h.queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO contacts'))!;
    // No identifier is copied into contacts.name, where masking never applies.
    expect(contactInsert.slice(1).some((v) => typeof v === 'string' && v.includes('9001'))).toBe(false);
    expect((contactInsert[0] as TemplateStringsArray).join('?')).toContain("'',NULL)");
    // The sender lock (shared with staff link/unlink) is taken before the identity read.
    const lockAt = h.executeRaw.mock.calls.findIndex((c) => (c[0] as TemplateStringsArray).join('?').includes('pg_advisory_xact_lock'));
    expect(h.executeRaw.mock.calls[lockAt].slice(1)).toEqual([`igsid:${igAccountId}:9001`]);
    expect(h.executeRaw.mock.invocationCallOrder[lockAt]).toBeLessThan(h.queryRaw.mock.invocationCallOrder[
      h.queryRaw.mock.calls.findIndex((c) => (c[0] as TemplateStringsArray).join('?').includes('FROM contact_channel_identities'))]);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest.mock.calls[0][0]).toMatchObject({
      accountId, contactId, conversationId: 'conv-1', metaMessageId: 'm1', contentType: 'text', contentText: 'hi',
      wasContactCreated: true, wasConversationCreated: true,
    });
    expect(h.ingest.mock.calls[0][0]).not.toHaveProperty('whatsappConfigId');
    expect(h.ingest.mock.calls[0][0]).not.toHaveProperty('order');
    expect(h.findExistingContact).not.toHaveBeenCalled();
    expect(h.pickBestPhoneMatch).not.toHaveBeenCalled();
    // The profile fetch is queued for the new identity.
    expect(h.executeRaw.mock.calls.some((c) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO jobs'))).toBe(true);
  });

  it('counts reactions and comments without the comments scope as unsupported, storing no message', async () => {
    const accountId = '22222222-2222-4222-8222-222222222222';
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM webhook_receipts'))
        return [{ status: 'received', payload: { object: 'instagram', entry: [{ id: ACCOUNT_IG,
          messaging: [{ sender: { id: '9001' }, recipient: { id: ACCOUNT_IG }, timestamp: 1, reaction: { mid: 'm1' } }],
          changes: [{ field: 'comments', value: { id: '555', text: 'x', from: { id: '9001' } } }] }] } }];
      if (sql.includes('crm_resolve_instagram_account')) return [{ account_id: accountId, instagram_account_id: 'ig' }];
      if (sql.includes('FROM instagram_accounts a JOIN accounts'))
        return [{ scopes: ['instagram_business_basic', 'instagram_business_manage_messages'], connected_by_user_id: 'u', owner_user_id: 'u' }];
      if (sql.includes('set_config')) return [];
      throw new Error(`unexpected query: ${sql}`);
    });
    h.executeRaw.mockResolvedValue(1);
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(h.ingest).not.toHaveBeenCalled();
    const counter = h.executeRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('unsupported_event_count'));
    expect(counter?.slice(1)).toContain(2);
    expect(h.executeRaw.mock.calls.some((c) => (c[0] as TemplateStringsArray).join('?').includes('instagram_comment_events'))).toBe(false);
  });

  it('adds unsupported counts only in the transaction that marks the receipt processed, so a retry never double counts', async () => {
    const accountId = '22222222-2222-4222-8222-222222222222';
    const reaction = { sender: { id: '9001' }, recipient: { id: ACCOUNT_IG }, timestamp: 1, reaction: { mid: 'm1' } };
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM webhook_receipts'))
        return [{ status: 'received', payload: { object: 'instagram', entry: [
          { id: ACCOUNT_IG, messaging: [reaction, reaction] },
          { id: ACCOUNT_IG, messaging: [msg({ mid: 'm1', text: 'hi' })] },
        ] } }];
      if (sql.includes('crm_resolve_instagram_account')) return [{ account_id: accountId, instagram_account_id: 'ig' }];
      if (sql.includes('FROM instagram_accounts a JOIN accounts'))
        return [{ scopes: ['instagram_business_basic', 'instagram_business_manage_messages'], connected_by_user_id: 'u', owner_user_id: 'u' }];
      if (sql.includes('set_config')) return [];
      // The second entry's message fails (for example a DB timeout) on the first attempt.
      if (sql.includes('FROM contact_channel_identities')) throw new Error('transient');
      throw new Error(`unexpected query: ${sql}`);
    });
    h.executeRaw.mockResolvedValue(1);
    const counterCalls = () => h.executeRaw.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('?').includes('unsupported_event_count'));
    await expect(processInstagramWebhookJob({ receiptId: RECEIPT })).rejects.toThrow('transient');
    expect(counterCalls()).toHaveLength(0);

    // The retry succeeds and counts the first entry's two reactions once.
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM webhook_receipts'))
        return [{ status: 'received', payload: { object: 'instagram', entry: [
          { id: ACCOUNT_IG, messaging: [reaction, reaction] }, { id: ACCOUNT_IG, messaging: [reaction] }] } }];
      if (sql.includes('crm_resolve_instagram_account')) return [{ account_id: accountId, instagram_account_id: 'ig' }];
      if (sql.includes('FROM instagram_accounts a JOIN accounts'))
        return [{ scopes: ['instagram_business_basic'], connected_by_user_id: 'u', owner_user_id: 'u' }];
      if (sql.includes('set_config')) return [];
      throw new Error(`unexpected query: ${sql}`);
    });
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(counterCalls()).toHaveLength(1);
    expect(counterCalls()[0].slice(1)).toContain(3);
    const order = (needle: string) => h.executeRaw.mock.invocationCallOrder[
      h.executeRaw.mock.calls.findIndex((c) => (c[0] as TemplateStringsArray).join('?').includes(needle))];
    expect(order("SET status='processed'")).toBeLessThan(order('unsupported_event_count'));

    // A receipt another attempt already marked processed adds nothing.
    h.executeRaw.mockClear();
    h.executeRaw.mockResolvedValue(0);
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(counterCalls()).toHaveLength(0);
  });

  it('queues no private reply for a blocked contact and marks the comment rejected', async () => {
    const accountId = '22222222-2222-4222-8222-222222222222';
    const comments = (blocked: boolean) => async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM webhook_receipts'))
        return [{ status: 'received', payload: { object: 'instagram', entry: [{ id: ACCOUNT_IG,
          changes: [{ field: 'comments', value: { id: '555', text: 'price?', media: { id: '777' }, from: { id: '9001' } } }] }] } }];
      if (sql.includes('crm_resolve_instagram_account')) return [{ account_id: accountId, instagram_account_id: 'ig' }];
      if (sql.includes('FROM instagram_accounts a JOIN accounts'))
        return [{ scopes: ['instagram_business_basic', 'instagram_business_manage_comments'], connected_by_user_id: 'u', owner_user_id: 'u' }];
      if (sql.includes('INSERT INTO instagram_comment_events')) return [{ id: 'ev-1' }];
      if (sql.includes('FROM instagram_comment_rules')) return [{ id: 'rule-1', media_id: null, keywords: ['price'] }];
      if (sql.includes('blocked_at IS NOT NULL')) return [{ blocked }];
      // No live comment flows (Stage 2): the legacy rule path runs as before.
      if (sql.includes('FROM flows f JOIN flow_versions')) return [];
      throw new Error(`unexpected query: ${sql}`);
    };
    const jobs = () => h.executeRaw.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO jobs'));
    const status = () => h.executeRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('private_reply_status'))!.slice(1);
    h.executeRaw.mockResolvedValue(1);

    h.queryRaw.mockImplementation(comments(true));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(jobs()).toHaveLength(0);
    expect(status()).toContain('rejected');

    h.executeRaw.mockClear();
    h.queryRaw.mockImplementation(comments(false));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(jobs()).toHaveLength(1);
    expect(status()).toContain('queued');
  });

  it('offers a first comment to the live comment flows, skipping the rule and keeping it as the fallback (Stage 2)', async () => {
    const accountId = '22222222-2222-4222-8222-222222222222';
    const flowId = '33333333-3333-4333-8333-333333333333';
    const run = (earlier: boolean, config: Record<string, unknown>, flowTaken = false) => async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM webhook_receipts'))
        return [{ status: 'received', payload: { object: 'instagram', entry: [{ id: ACCOUNT_IG,
          changes: [{ field: 'comments', value: { id: '555', text: 'PRICE please', media: { id: '777' }, from: { id: '9001' } } }] }] } }];
      if (sql.includes('crm_resolve_instagram_account')) return [{ account_id: accountId, instagram_account_id: 'ig' }];
      if (sql.includes('FROM instagram_accounts a JOIN accounts'))
        return [{ scopes: ['instagram_business_basic', 'instagram_business_manage_comments'], connected_by_user_id: 'u', owner_user_id: 'u' }];
      if (sql.includes('INSERT INTO instagram_comment_events')) return [{ id: 'ev-1' }];
      if (sql.includes('FROM instagram_comment_rules')) return [{ id: 'rule-1', media_id: null, keywords: ['price'] }];
      if (sql.includes('FROM flows f JOIN flow_versions')) return [{ id: flowId, created_at: new Date('2026-11-01T00:00:00Z'), trigger_config: config }];
      if (sql.includes('id<>')) return [{ found: earlier, flow_taken: earlier && flowTaken }];
      if (sql.includes('blocked_at IS NOT NULL')) return [{ blocked: false }];
      throw new Error(`unexpected query: ${sql}`);
    };
    const jobCalls = () => h.executeRaw.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO jobs'));
    h.executeRaw.mockResolvedValue(1);

    h.queryRaw.mockImplementation(run(false, { post_scope: 'any', include_keywords: ['price'] }));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(jobCalls()).toHaveLength(1);
    const payload = JSON.parse(jobCalls()[0][3] as string);
    expect(payload).toEqual({ accountId, eventId: 'ev-1', flows: [{ flowId, check: false }], fallbackRuleId: 'rule-1' });
    // Ids only: the comment text never reaches the job.
    expect(jobCalls()[0][3]).not.toContain('PRICE');
    // The sender lock is taken before the event is recorded, so only one comment is a person's first.
    const first = h.executeRaw.mock.calls.findIndex((c) => (c[0] as TemplateStringsArray).join('?').includes('pg_advisory_xact_lock'));
    expect(first).toBeGreaterThanOrEqual(0);

    // Not the person's first comment on the post: the rule answers as before.
    h.executeRaw.mockClear();
    h.queryRaw.mockImplementation(run(true, { post_scope: 'any' }));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(JSON.parse(jobCalls()[0][3] as string)).toEqual({ accountId, eventId: 'ev-1' });

    // A flow already answered this person's earlier comment on the post: no second DM from the rule.
    h.executeRaw.mockClear();
    h.queryRaw.mockImplementation(run(true, { post_scope: 'any' }, true));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(jobCalls()).toHaveLength(0);
    const skipped = h.executeRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE instagram_comment_events'))!;
    expect(skipped.slice(1)).toEqual(expect.arrayContaining([null, 'no_rule']));

    // A keyword the flow does not want: the rule answers.
    h.executeRaw.mockClear();
    h.queryRaw.mockImplementation(run(false, { post_scope: 'any', include_keywords: ['link'] }));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(JSON.parse(jobCalls()[0][3] as string)).toEqual({ accountId, eventId: 'ev-1' });

    // An unresolved "next post" flow is offered for the job to check against Graph.
    h.executeRaw.mockClear();
    h.queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('?').includes("vars->>'ig_media_id'") ? [] : run(false, { post_scope: 'next', next_after: '2026-11-01T00:00:00Z' })(strings, ...(values as [])));
    await processInstagramWebhookJob({ receiptId: RECEIPT });
    expect(JSON.parse(jobCalls()[0][3] as string).flows).toEqual([{ flowId, check: true }]);
  });
});

describe('Stage 2 story parsing (needs live capture: built against documented shapes)', () => {
  it('keeps the story id and marks an emoji-only reply as a reaction', () => {
    const reply = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 's1', text: 'so good', reply_to: { story: { id: '18011', url: 'https://cdn.example/s' } } }), NOW);
    expect(reply).toMatchObject({ items: [{ contentType: 'story_reply', ig: { story: true, story_id: '18011' } }] });
    expect((reply as { items: Array<{ ig: Record<string, unknown> }> }).items[0].ig.reaction).toBeUndefined();
    const reaction = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 's2', text: '\u{1F525}\u{1F525}', reply_to: { story: { id: '18011' } } }), NOW);
    expect(reaction).toMatchObject({ items: [{ contentType: 'story_reply', ig: { story: true, story_id: '18011', reaction: true } }] });
    const badId = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 's3', text: 'hi', reply_to: { story: { id: '../x' } } }), NOW);
    expect((badId as { items: Array<{ ig: Record<string, unknown> }> }).items[0].ig.story_id).toBeUndefined();
  });

  it('stores a story mention as a share with the mention flag', () => {
    const mention = parseMessagingEvent(ACCOUNT_IG, msg({ mid: 's4', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example/m' } }] }), NOW);
    expect(mention).toMatchObject({ kind: 'message', items: [{ contentType: 'share', mediaUrl: null, ig: { story_mention: true, url: 'https://cdn.example/m' } }] });
  });

  it('tells emoji-only text from words and numbers', () => {
    expect(isEmojiOnly('\u{1F60D}')).toBe(true);
    expect(isEmojiOnly('\u{1F44D}\u{1F3FD}')).toBe(true);
    expect(isEmojiOnly(String.fromCodePoint(0x2764, 0xfe0f))).toBe(true);
    expect(isEmojiOnly('love it \u{1F60D}')).toBe(false);
    expect(isEmojiOnly('123')).toBe(false);
    expect(isEmojiOnly('')).toBe(false);
    expect(isEmojiOnly(null)).toBe(false);
  });
});
