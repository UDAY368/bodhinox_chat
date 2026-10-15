import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IngestInboundInput,
  MessageActionsPayload,
} from '@/lib/whatsapp/ingest';

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  resumeAwaitingReply: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  ingestInputs: [] as IngestInboundInput[],
  fixtureActions: [] as MessageActionsPayload[],
  applyProviderStatus: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: '55555555-5555-4555-8555-555555555555' }] as {
      id: string;
    }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: {
      id: '33333333-3333-4333-8333-333333333333',
      unread_count: 0,
      account_id: '11111111-1111-4111-8111-111111111111',
      inbound_created_meta_id: null as string | null,
    },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string;
      path: string;
      options: { contentType?: string };
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** Row `findContactByWaUserId` resolves for a BSUID lookup (#519). */
    contactByWaUserId: null as Record<string, unknown> | null,
    /** Rows inserted into `contacts`. */
    contactInserts: [] as Record<string, unknown>[],
    /** Patches applied to an existing `contacts` row. */
    contactUpdates: [] as Record<string, unknown>[],
    /** Patches applied to `messages` by a status webhook (#535). */
    messageUpdates: [] as Record<string, unknown>[],
    /** Row the status webhook's broadcast_recipients lookup resolves. */
    broadcastRecipient: null as { id: string; status: string } | null,
    /** Patches applied to that broadcast_recipients row. */
    recipientUpdates: [] as Record<string, unknown>[],
  },
}));

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}));

vi.mock('@/lib/data/admin', () => ({
  createAdminClient: (scope: { accountId?: string }) => {
    if (scope?.accountId !== '11111111-1111-4111-8111-111111111111')
      throw new Error('Processor queries require the resolved tenant scope');
    return {
      from(table: string) {
        switch (table) {
          case 'whatsapp_config':
            return {
              select: () => {
                const query = {
                  eq: () => query,
                  single: async () => ({
                    data: {
                      account_id: '11111111-1111-4111-8111-111111111111',
                      user_id: '22222222-2222-4222-8222-222222222222',
                      access_token: 'enc',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                    error: null,
                  }),
                };
                return query;
              },
            };
          case 'conversations':
            // findOrCreateConversation: select().eq().eq().order().limit()
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: () =>
                        Promise.resolve({
                          data: [h.state.conversation],
                          error: null,
                        }),
                    }),
                  }),
                }),
              }),
            };
          case 'broadcast_recipients':
            // Two chains land here:
            //   flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
            //   handleStatusUpdate:      select().eq().maybeSingle(), then
            //                            update().eq()
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    in: () => ({
                      order: () => ({
                        limit: () => Promise.resolve({ data: [], error: null }),
                      }),
                    }),
                  }),
                  maybeSingle: () =>
                    Promise.resolve({
                      data: h.state.broadcastRecipient,
                      error: null,
                    }),
                }),
              }),
              update: (patch: Record<string, unknown>) => {
                h.state.recipientUpdates.push(patch);
                return { eq: () => Promise.resolve({ error: null }) };
              },
            };
          case 'contacts':
            // Three chains land here, all from findOrCreateContact:
            //   findContactByWaUserId: select('*').eq().eq().maybeSingle()
            //   identity backfill:     update().eq().select().maybeSingle()
            //   create:                insert().select().single()
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: h.state.contactByWaUserId,
                        error: null,
                      }),
                  }),
                }),
              }),
              update: (patch: Record<string, unknown>) => {
                h.state.contactUpdates.push(patch);
                return {
                  eq: () => ({
                    select: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: null, error: null }),
                    }),
                  }),
                };
              },
              insert: (row: Record<string, unknown>) => {
                h.state.contactInserts.push(row);
                return {
                  select: () => ({
                    single: () =>
                      Promise.resolve({
                        data: {
                          id: '66666666-6666-4666-8666-666666666666',
                          ...row,
                        },
                        error: null,
                      }),
                  }),
                };
              },
            };
          case 'messages':
            return {
              // Two different chains land here, told apart by the count
              // option: the prior-message count (head request) and the
              // reply-context parent lookup.
              select: (_columns: string, options?: { head?: boolean }) =>
                options?.head
                  ? // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
                    {
                      eq: () => ({
                        eq: () =>
                          Promise.resolve({
                            count: h.state.priorCustomerMsgCount,
                            error: null,
                          }),
                      }),
                    }
                  : // lookupInternalIdByMetaId: select('id').eq().eq().maybeSingle()
                    // handleStatusUpdate fan-out: select().eq().limit().maybeSingle()
                    {
                      eq: () => ({
                        eq: () => ({
                          maybeSingle: () =>
                            Promise.resolve({
                              data: h.state.replyContextParent,
                              error: null,
                            }),
                        }),
                        limit: () => ({
                          maybeSingle: () =>
                            Promise.resolve({ data: null, error: null }),
                        }),
                      }),
                    },
              // Status webhook mirror (#535): update(...).eq('message_id', ...)
              update: (patch: Record<string, unknown>) => {
                h.state.messageUpdates.push(patch);
                return { eq: () => Promise.resolve({ error: null }) };
              },
              // Idempotent insert: upsert(...).select('id')
              upsert: (row: Record<string, unknown>, options: unknown) => {
                h.state.upsertCalls.push({ row, options });
                return {
                  select: () =>
                    Promise.resolve({
                      data: h.state.messageUpsertResult,
                      error: null,
                    }),
                };
              },
            };
          default:
            throw new Error(`unexpected table: ${table}`);
        }
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        h.state.rpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      },
      // Service-role Storage, used by the inbound-media mirror (#466).
      storage: {
        from(bucket: string) {
          return {
            upload: (
              path: string,
              _body: unknown,
              options: { contentType?: string }
            ) => {
              h.state.storageUploads.push({ bucket, path, options });
              return Promise.resolve({ error: h.state.storageUploadError });
            },
            getPublicUrl: (path: string) => ({
              data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
            }),
          };
        },
      },
    };
  },
}));
vi.mock('@/lib/repositories/routing', () => ({
  resolveWhatsAppAccount: vi.fn(
    async () => '11111111-1111-4111-8111-111111111111'
  ),
  resolveWabaAccount: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
}));
vi.mock('@/lib/storage/server', () => ({
  createServerStorageFacade: () => ({
    from(bucket: string) {
      return {
        upload: async (
          path: string,
          _body: unknown,
          options: { contentType?: string }
        ) => {
          h.state.storageUploads.push({ bucket, path, options });
          return { error: h.state.storageUploadError };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
        }),
      };
    },
  }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}));

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: (field: string) =>
    field.startsWith('message_template_'),
  handleTemplateWebhookChange: vi.fn(),
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
  resumeAwaitingReply: h.resumeAwaitingReply,
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}));
vi.mock('@/lib/whatsapp/ingest', () => ({
  ingestInboundMessage: vi.fn(async (input: IngestInboundInput) => {
    h.ingestInputs.push(input);
    h.state.upsertCalls.push({
      row: {
        conversation_id: input.conversationId,
        sender_type: 'customer',
        content_type: input.contentType,
        content_text: input.contentText,
        media_url: input.mediaUrl,
        media_type: input.mediaType,
        message_id: input.metaMessageId,
        status: 'delivered',
        created_at: input.createdAt.toISOString(),
        reply_to_message_id: input.replyToMessageId,
        interactive_reply_id: input.interactiveReplyId,
      },
      options: {},
    });
    const inserted = Boolean(h.state.messageUpsertResult.length),
      messageId =
        h.state.messageUpsertResult[0]?.id ??
        '55555555-5555-4555-8555-555555555555',
      isFirstInboundMessage = h.state.priorCustomerMsgCount === 0;
    if (inserted)
      h.fixtureActions.push({
        kind: 'message',
        messageId,
        accountId: input.accountId,
        userId: input.userId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        metaMessageId: input.metaMessageId,
        contentType: input.contentType,
        contentText: input.contentText,
        interactiveReplyId: input.interactiveReplyId,
        wasContactCreated: input.wasContactCreated,
        wasConversationCreated: input.wasConversationCreated,
        isFirstInboundMessage,
      });
    return { messageId, inserted, isFirstInboundMessage };
  }),
  applyProviderStatus: h.applyProviderStatus,
  runInboundStage: async <T>(
    _accountId: string,
    _messageId: string,
    _stage: string,
    action: () => Promise<T>
  ) => action(),
}));

import {
  processWebhook,
  processInboundActions,
} from '@/lib/whatsapp/process-webhook';
async function POST(request: Request) {
  await processWebhook(JSON.parse(await request.text()));
  for (const actions of h.fixtureActions.splice(0))
    await processInboundActions(actions);
}
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { handleTemplateWebhookChange } from '@/lib/whatsapp/template-webhook';

const mockGetMediaUrl = vi.mocked(getMediaUrl);
const mockDownloadMedia = vi.mocked(downloadMedia);
const mockFindExistingContact = vi.mocked(findExistingContact);

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
};

const LEGACY_CONTACTS = [{ wa_id: '15551230000', profile: { name: 'Ada' } }];

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  contacts: Record<string, unknown>[] = LEGACY_CONTACTS
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts,
              messages: [message],
            },
          },
        ],
      },
    ],
  };
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request;
}

async function runWebhook(
  message?: Record<string, unknown>,
  contacts?: Record<string, unknown>[]
) {
  const res = await POST(inboundRequest(message, contacts));
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb();
  return res;
}

/** A message-status webhook (sent / delivered / read / failed). */
async function runStatusWebhook(status: Record<string, unknown>) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              statuses: [status],
            },
          },
        ],
      },
    ],
  };
  const res = await POST({
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request);
  for (const cb of h.state.afterCallbacks) await cb();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ingestInputs = [];
  h.fixtureActions = [];
  h.applyProviderStatus.mockResolvedValue(undefined);
  h.state.messageUpsertResult = [
    { id: '55555555-5555-4555-8555-555555555555' },
  ];
  h.state.priorCustomerMsgCount = 0;
  h.state.replyContextParent = null;
  h.state.conversation = {
    id: '33333333-3333-4333-8333-333333333333',
    unread_count: 0,
    account_id: '11111111-1111-4111-8111-111111111111',
    inbound_created_meta_id: null,
  };
  h.state.upsertCalls = [];
  h.state.rpcCalls = [];
  h.state.afterCallbacks = [];
  h.state.automationStarted = 0;
  h.state.automationCompleted = 0;
  h.state.mirrorInboundMedia = true;
  h.state.storageUploads = [];
  h.state.storageUploadError = null;
  h.state.contactByWaUserId = null;
  h.state.contactInserts = [];
  h.state.contactUpdates = [];
  h.state.messageUpdates = [];
  h.state.broadcastRecipient = null;
  h.state.recipientUpdates = [];
  mockFindExistingContact.mockResolvedValue({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Ada',
    phone: '15551230000',
  });
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  });
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  });
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false });
  h.resumeAwaitingReply.mockResolvedValue(false);
  h.dispatchInboundToAiReply.mockResolvedValue(undefined);
  h.dispatchWebhookEvent.mockResolvedValue(undefined);
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++;
        resolve();
      }, 0);
    });
  });
});

describe('inbound webhook: idempotent insert (#367)', () => {
  it('recovers creation flags when the same provider message retries after contact/conversation creation', async () => {
    h.state.conversation.inbound_created_meta_id = TEXT_MESSAGE.id;
    mockFindExistingContact.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      phone: '15551230000',
      name: 'Ada',
      inbound_created_meta_id: TEXT_MESSAGE.id,
    });
    await runWebhook();
    expect(h.ingestInputs[0]).toMatchObject({
      wasContactCreated: true,
      wasConversationCreated: true,
    });
  });
  it('does not recreate creation flags for an existing row marked by a different provider message', async () => {
    h.state.conversation.inbound_created_meta_id = 'wamid.PREVIOUS';
    mockFindExistingContact.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      phone: '15551230000',
      name: 'Ada',
      inbound_created_meta_id: 'wamid.PREVIOUS',
    });
    await runWebhook();
    expect(h.ingestInputs[0]).toMatchObject({
      wasContactCreated: false,
      wasConversationCreated: false,
    });
  });
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook();

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.ingestInputs[0]).toMatchObject({
      accountId: '11111111-1111-4111-8111-111111111111',
      conversationId: '33333333-3333-4333-8333-333333333333',
      metaMessageId: 'wamid.TEST1',
    });
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1);
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = [];

    await runWebhook();

    expect(h.state.upsertCalls).toHaveLength(1);
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('delegates message identity and unread/job persistence to one atomic adapter', async () => {
    await runWebhook();

    expect(h.ingestInputs).toHaveLength(1);
    expect(h.ingestInputs[0]).toMatchObject({
      conversationId: '33333333-3333-4333-8333-333333333333',
      accountId: '11111111-1111-4111-8111-111111111111',
      contentText: 'hello',
    });
    expect(h.state.rpcCalls).toHaveLength(0);
  });
});

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  };

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap);

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    });
  });

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap);

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      })
    );
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType
    );
    expect(triggers).toContain('interactive_reply');
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    });

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    });
  });
});

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  };

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.storageUploads).toHaveLength(1);
    expect(h.state.storageUploads[0].bucket).toBe('chat-media');
    expect(h.state.storageUploads[0].path).toBe(
      'account-11111111-1111-4111-8111-111111111111/inbound/1234567890123456-image-1700000000.jpg'
    );
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-11111111-1111-4111-8111-111111111111/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    });
  });

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' };

    await runWebhook(IMAGE_MESSAGE);

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    });
  });

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(
      new Error('Media download failed: 404')
    );

    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    });
  });

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    });

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    });

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    });
  });

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    });
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    });

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    });

    expect(h.state.storageUploads[0].path).toBe(
      'account-11111111-1111-4111-8111-111111111111/inbound/1234567890123456-invoice.pdf'
    );
  });

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false;

    await runWebhook(IMAGE_MESSAGE);

    expect(mockDownloadMedia).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    });
  });

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined;

    await runWebhook(IMAGE_MESSAGE);

    expect(h.state.storageUploads).toHaveLength(1);
  });

  it('leaves text messages alone', async () => {
    await runWebhook();

    expect(mockGetMediaUrl).not.toHaveBeenCalled();
    expect(h.state.storageUploads).toHaveLength(0);
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null });
  });
});

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook();

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3);
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3);
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta stopped sending the phone number for a customer who has adopted
// a WhatsApp username: `messages[].from` and `contacts[].wa_id` are
// both absent, and only `from_user_id` / `user_id` identify them.
//
// Before the fix, `normalizePhone(undefined)` gave '', which
// `findExistingContact` refuses to look up, so every such delivery
// inserted a NEW contact — and migration 022's unique index is partial
// (`WHERE phone_normalized <> ''`) so nothing stopped it. One contact
// and one conversation per inbound message.
// ============================================================

const USERNAME_ONLY_MESSAGE = {
  id: 'wamid.BSUID1',
  from_user_id: 'US.13491208655302741918',
  from_parent_user_id: 'US.ENT.11815799212886844830',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'does it come in another color?' },
};

const USERNAME_ONLY_CONTACTS = [
  {
    profile: { name: 'Sheena Nelson', username: 'realsheenanelson' },
    user_id: 'US.13491208655302741918',
    parent_user_id: 'US.ENT.11815799212886844830',
  },
];

describe('inbound webhook: business-scoped user IDs (#519)', () => {
  it('creates ONE contact keyed on the BSUID when Meta sends no phone', async () => {
    // Nothing on file under either key yet.
    h.state.contactByWaUserId = null;
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS);

    expect(h.state.contactInserts).toHaveLength(1);
    expect(h.state.contactInserts[0]).toMatchObject({
      account_id: '11111111-1111-4111-8111-111111111111',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
      name: 'Sheena Nelson',
    });
    // The message still lands in the thread.
    expect(h.state.upsertCalls).toHaveLength(1);
  });

  it('never looks the sender up by phone when there is no phone', async () => {
    h.state.contactByWaUserId = null;
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS);

    // The old code called this with '' and got null every time, which
    // is exactly how the duplicate contacts got created.
    expect(mockFindExistingContact).not.toHaveBeenCalled();
  });

  it('reuses the existing contact on the SECOND message from the same BSUID', async () => {
    // The row the first message created.
    h.state.contactByWaUserId = {
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
    };
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(
      { ...USERNAME_ONLY_MESSAGE, id: 'wamid.BSUID2' },
      USERNAME_ONLY_CONTACTS
    );

    expect(h.state.contactInserts).toHaveLength(0);
    // Nothing about the identity changed, so no pointless UPDATE either.
    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it('backfills the BSUID onto a contact we already knew by phone', async () => {
    // Transition payload: Meta sends both keys. We match on the phone
    // and stamp the BSUID so the next phone-less message still finds
    // this row instead of forking a new one.
    mockFindExistingContact.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Pablo',
      phone: '16505551234',
    });

    await runWebhook(
      {
        id: 'wamid.BOTH',
        from: '16505551234',
        from_user_id: 'US.13491208655302741918',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi' },
      },
      [
        {
          profile: { name: 'Pablo', username: 'pablomorales' },
          wa_id: '16505551234',
          user_id: 'US.13491208655302741918',
        },
      ]
    );

    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.contactUpdates).toHaveLength(1);
    expect(h.state.contactUpdates[0]).toMatchObject({
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'pablomorales',
    });
    // The number we already had is left alone.
    expect(h.state.contactUpdates[0]).not.toHaveProperty('phone');
  });

  it('fills in the phone once Meta finally discloses it', async () => {
    h.state.contactByWaUserId = {
      id: '77777777-7777-4777-8777-777777777777',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'realsheenanelson',
    };

    await runWebhook(
      {
        ...USERNAME_ONLY_MESSAGE,
        id: 'wamid.BSUID3',
        from: '16505551234',
      },
      USERNAME_ONLY_CONTACTS
    );

    expect(h.state.contactUpdates).toHaveLength(1);
    expect(h.state.contactUpdates[0]).toMatchObject({ phone: '16505551234' });
  });

  it('drops a delivery that carries neither key rather than inventing a contact', async () => {
    mockFindExistingContact.mockResolvedValue(null);

    await runWebhook(
      {
        id: 'wamid.ANON',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'who am i' },
      },
      [{ profile: { name: 'Nobody' } }]
    );

    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled();
    // The durable receipt HTTP contract is tested separately; processing an
    // unusable identity performs no domain side effects and does not throw.
  });

  it('leaves the legacy phone-only payload behaving exactly as before', async () => {
    await runWebhook();

    expect(mockFindExistingContact).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
      '15551230000'
    );
    expect(h.state.contactInserts).toHaveLength(0);
    expect(h.state.contactUpdates).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
  });
});

describe('inbound webhook: contact name backfill (#519 regression guard)', () => {
  it('never overwrites an edited name with the phone number', async () => {
    // Meta sends no profile name. The display fallback would resolve to
    // the phone number, and writing that back would replace whatever an
    // agent typed on the contact — on every single inbound message.
    mockFindExistingContact.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Ada (VIP, calls Mondays)',
      phone: '15551230000',
    });

    await runWebhook(TEXT_MESSAGE, [{ wa_id: '15551230000', profile: {} }]);

    expect(h.state.contactUpdates).toHaveLength(0);
  });

  it('does adopt a username when that is all Meta gives us', async () => {
    mockFindExistingContact.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      name: '15551230000',
      phone: '15551230000',
    });

    await runWebhook(TEXT_MESSAGE, [
      { wa_id: '15551230000', profile: { username: 'ada' } },
    ]);

    expect(h.state.contactUpdates[0]).toMatchObject({ name: 'ada' });
  });
});

describe('template-lifecycle webhooks: WABA id is threaded to the handler (#534)', () => {
  it('passes entry.id as wabaId so an unknown template can be stubbed for the right account', async () => {
    const value = {
      event: 'APPROVED',
      message_template_id: '4242',
      message_template_name: 'created_in_meta',
      message_template_language: 'en_US',
    };
    const body = {
      entry: [
        {
          id: 'WABA-1',
          changes: [{ field: 'message_template_status_update', value }],
        },
      ],
    };
    const req = {
      text: async () => JSON.stringify(body),
      headers: { get: () => 'sha256=stub' },
    } as unknown as Request;

    await POST(req);
    for (const cb of h.state.afterCallbacks) await cb();

    const mockHandle = vi.mocked(handleTemplateWebhookChange);
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(mockHandle.mock.calls[0][0]).toEqual({
      field: 'message_template_status_update',
      value,
      wabaId: 'WABA-1',
    });
    // A template event must not fall through to the messaging branch.
    expect(h.state.upsertCalls).toHaveLength(0);
  });
});

describe("status webhook: failed statuses keep Meta's reason (#535)", () => {
  const FAILED_STATUS = {
    id: 'wamid.OUT1',
    status: 'failed',
    timestamp: '1700000100',
    recipient_id: '15551230000',
    errors: [
      {
        code: 131049,
        title:
          'This message was not delivered to maintain healthy ecosystem engagement.',
        message:
          'This message was not delivered to maintain healthy ecosystem engagement.',
        error_data: {
          details:
            'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        },
        href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
      },
    ],
  };

  it('passes the full failure envelope to the tenant-scoped atomic adapter', async () => {
    await runStatusWebhook(FAILED_STATUS);
    expect(h.applyProviderStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      FAILED_STATUS
    );
  });
  it('does not perform non-atomic message or recipient updates in the processor', async () => {
    await runStatusWebhook(FAILED_STATUS);
    expect(h.state.messageUpdates).toHaveLength(0);
    expect(h.state.recipientUpdates).toHaveLength(0);
    expect(h.applyProviderStatus).toHaveBeenCalledTimes(1);
  });
  it('propagates durable status persistence errors for worker retry', async () => {
    h.applyProviderStatus.mockRejectedValueOnce(
      new Error('Status persistence failed')
    );
    await expect(runStatusWebhook(FAILED_STATUS)).rejects.toThrow(
      'Status persistence failed'
    );
  });
  it('accepts a failed status without a reason array', async () => {
    const status = { ...FAILED_STATUS, errors: undefined };
    await runStatusWebhook(status);
    expect(h.applyProviderStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      status
    );
  });
  it('passes a delivered status without inventing a failure reason', async () => {
    const status = {
      id: 'wamid.OUT1',
      status: 'delivered',
      timestamp: '1700000100',
      recipient_id: '15551230000',
    };
    await runStatusWebhook(status);
    expect(h.applyProviderStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      status
    );
  });
});
describe('inbound webhook: automation waiting for a reply', () => {
  const triggersFired = () =>
    h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType
    );

  it('offers the message to a waiting automation before any trigger fires', async () => {
    await runWebhook();

    expect(h.resumeAwaitingReply).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ message_text: 'hello' }),
      })
    );
    // Nothing was waiting, so the content triggers fire as normal.
    expect(triggersFired()).toEqual(
      expect.arrayContaining(['new_message_received', 'keyword_match'])
    );
  });

  it('suppresses content triggers and AI reply when a waiting automation took it', async () => {
    h.resumeAwaitingReply.mockResolvedValue(true);

    await runWebhook();

    expect(triggersFired()).not.toContain('new_message_received');
    expect(triggersFired()).not.toContain('keyword_match');
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled();
  });

  it('leaves the message to a flow that consumed it', async () => {
    h.dispatchInboundToFlows.mockResolvedValue({ consumed: true });

    await runWebhook();

    expect(h.resumeAwaitingReply).not.toHaveBeenCalled();
  });
});
