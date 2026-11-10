// Channel-aware flow sends (Phase 11, design section 8).
//
// Every flow step that messages the customer goes through flowSend with the
// step's existing outbound intent key, so the WhatsApp path is exactly what it
// was: dispatchOnce(key, engineSend*) (meta-send.ts, unchanged).
//
// On an Instagram conversation the send is prepared and refused BEFORE any
// intent exists (src/lib/channels/sender.ts): window closed, account
// disconnected / token invalid / scope missing, text over 1000 bytes, choices
// that do not fit quick replies, a media type Instagram cannot carry, or a
// location/address request. Those surface as the step's failure in the run log
// (an InstagramError / ChannelUnavailableError message carries only the fixed
// code). Only the Graph call happens inside dispatchOnce, so an ambiguous
// outcome stays 'unknown' and is never re-sent. Flow sends are automated: they
// never carry the Human Agent tag.
//
// Stage 2 adds the Instagram-only shapes: cards and galleries (generic
// template) and button templates (text with link or postback buttons).
//
// The channel always comes from the conversation row, never from the run's
// variables or the inbound payload. Nothing here logs customer content.
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { assertBotRepliesEnabled } from '@/lib/whatsapp/bot-pause';
import { providerMediaUrl } from '@/lib/storage/server';
import {
  ChannelUnavailableError,
  checkInstagramButtonTemplate,
  checkInstagramCards,
  checkInstagramChoices,
  checkInstagramMedia,
  checkInstagramText,
  loadInstagramTarget,
  sendInstagramButtonTemplate,
  sendInstagramCards,
  sendInstagramChoices,
  sendInstagramMedia,
  sendInstagramText,
  storeInstagramSentMessage,
  type InstagramMedia,
  type InstagramSendContext,
  type InstagramTarget,
} from '@/lib/channels/sender';
import type { Channel } from '@/lib/channels/capabilities';
import type { IgGenericCard, IgTemplateButton, QuickReply, SentMessage } from '@/lib/instagram/graph';
import { databaseAdmin } from './admin-client';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from './meta-send';

type TextArgs = Parameters<typeof engineSendText>[0];
type MediaArgs = Parameters<typeof engineSendMedia>[0];
type ButtonsArgs = Parameters<typeof engineSendInteractiveButtons>[0];
type ListArgs = Parameters<typeof engineSendInteractiveList>[0];

/** The run a send belongs to (the Instagram-only sends carry just this). */
interface InstagramOnlyArgs { accountId: string; conversationId: string }

/**
 * One customer-facing flow send, in the shape the WhatsApp engine senders
 * take. `cards` (a card or gallery) and `button_template` (text with link or
 * postback buttons) exist only on Instagram: on a WhatsApp conversation they
 * are refused before any intent.
 */
export type FlowSend =
  | { kind: 'text'; args: TextArgs }
  | { kind: 'media'; args: MediaArgs }
  | { kind: 'buttons'; args: ButtonsArgs }
  | { kind: 'list'; args: ListArgs }
  | { kind: 'cards'; args: InstagramOnlyArgs & { cards: IgGenericCard[] } }
  | { kind: 'button_template'; args: InstagramOnlyArgs & { text: string; buttons: IgTemplateButton[] } };

type WhatsAppSend = Extract<FlowSend, { kind: 'text' | 'media' | 'buttons' | 'list' }>;

/** `whatsapp_message_id` keeps the engine's existing field name; on Instagram it is the Meta mid. */
export interface FlowSendResult {
  whatsapp_message_id: string;
  provider_message_id?: string;
}

interface RunRef {
  account_id: string;
  conversation_id: string | null;
}

const channelCache = new WeakMap<object, Promise<Channel>>();

/** The conversation's channel from its row; a missing row or a pre-Phase 11 row is WhatsApp. */
export async function conversationChannel(accountId: string, conversationId: string | null): Promise<Channel> {
  if (!conversationId) return 'whatsapp';
  const { data, error } = await databaseAdmin()
    .from('conversations')
    .select('channel')
    .eq('account_id', accountId)
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw new Error('Conversation channel lookup failed');
  return (data as { channel?: string | null } | null)?.channel === 'instagram' ? 'instagram' : 'whatsapp';
}

/** The run's conversation channel, read once per loaded run object (a conversation never changes channel). */
export function runChannel(run: RunRef): Promise<Channel> {
  let channel = channelCache.get(run);
  if (!channel) {
    channel = conversationChannel(run.account_id, run.conversation_id);
    channelCache.set(run, channel);
    channel.catch(() => channelCache.delete(run));
  }
  return channel;
}

function whatsappSend(send: WhatsAppSend): Promise<FlowSendResult> {
  switch (send.kind) {
    case 'text': return engineSendText(send.args);
    case 'media': return engineSendMedia(send.args);
    case 'buttons': return engineSendInteractiveButtons(send.args);
    case 'list': return engineSendInteractiveList(send.args);
  }
}

/**
 * Send a flow step's message on the run's channel under the step's intent key.
 * WhatsApp: unchanged. Instagram: refused before the intent when it cannot go.
 */
export async function flowSend(run: RunRef, key: string, send: FlowSend): Promise<FlowSendResult> {
  if ((await runChannel(run)) !== 'instagram') {
    // Instagram-only shapes never reach WhatsApp, and no intent is claimed for them.
    if (send.kind === 'cards' || send.kind === 'button_template') throw new ChannelUnavailableError('interactive');
    return dispatchOnce(run.account_id, key, () => whatsappSend(send));
  }
  return instagramFlowSend(key, send);
}

const joinText = (...parts: Array<string | undefined>): string =>
  parts.map((part) => part?.trim()).filter((part): part is string => !!part).join('\n\n');

interface Prepared {
  deliver: (ctx: InstagramSendContext) => Promise<SentMessage>;
  row: { content_type: string; content_text: string | null; interactive_payload?: Record<string, unknown> };
  preview: string;
  /** A media caption goes as a second message under its own intent. */
  caption?: string;
}

const MEDIA_TYPES: Record<string, InstagramMedia['type']> = { image: 'image', video: 'video', audio: 'audio', document: 'file' };

async function prepare(target: InstagramTarget, send: FlowSend, ctx: InstagramSendContext): Promise<Prepared> {
  switch (send.kind) {
    case 'text': {
      const { text, request } = send.args;
      if (request) throw new ChannelUnavailableError(request === 'location' ? 'location_request' : 'address_request');
      checkInstagramText(target, text, ctx);
      return {
        deliver: (c) => sendInstagramText(target, text, c),
        row: { content_type: 'text', content_text: text },
        preview: text,
      };
    }
    case 'media': {
      const { kind, caption, filename } = send.args;
      const type = MEDIA_TYPES[kind];
      if (!type) throw new ChannelUnavailableError('media_type');
      const url = await providerMediaUrl(send.args.accountId, send.args.link);
      // Instagram's only document type is a PDF.
      if (type === 'file' && ![filename, send.args.link, url].some((name) => typeof name === 'string' && /\.pdf(?:$|[?#])/i.test(name)))
        throw new ChannelUnavailableError('media_type');
      const media: InstagramMedia = { type, url };
      checkInstagramMedia(target, media, ctx);
      const text = caption?.trim() ? caption : undefined;
      if (text) checkInstagramText(target, text, ctx);
      return {
        deliver: (c) => sendInstagramMedia(target, media, c),
        row: { content_type: kind, content_text: null },
        preview: `[${kind}]`,
        caption: text,
      };
    }
    case 'buttons': {
      const { bodyText, headerText, footerText, buttons } = send.args;
      const text = joinText(headerText, bodyText, footerText);
      const choices: QuickReply[] = buttons.map((button) => ({ title: button.title, payload: button.id }));
      checkInstagramChoices(target, text, choices, ctx);
      return {
        deliver: (c) => sendInstagramChoices(target, text, choices, c),
        row: {
          content_type: 'interactive',
          content_text: bodyText,
          interactive_payload: {
            kind: 'buttons', body: bodyText, buttons: buttons.map(({ id, title }) => ({ id, title })),
            ig: { quick_replies: true },
          },
        },
        preview: bodyText,
      };
    }
    case 'cards': {
      const { cards } = send.args;
      checkInstagramCards(target, cards, ctx);
      return {
        deliver: (c) => sendInstagramCards(target, cards, c),
        row: {
          content_type: 'interactive',
          content_text: cards[0]?.title ?? null,
          interactive_payload: {
            kind: 'cards',
            cards: cards.map((card) => ({ title: card.title, subtitle: card.subtitle ?? null, image_url: card.imageUrl ?? null,
              buttons: (card.buttons ?? []).map((b) => ({ type: b.type, title: b.title })) })),
            ig: { generic_template: true },
          },
        },
        preview: cards[0]?.title ?? '[card]',
      };
    }
    case 'button_template': {
      const { text, buttons } = send.args;
      checkInstagramButtonTemplate(target, text, buttons, ctx);
      return {
        deliver: (c) => sendInstagramButtonTemplate(target, text, buttons, c),
        row: {
          content_type: 'interactive',
          content_text: text,
          interactive_payload: {
            kind: 'buttons', body: text,
            buttons: buttons.map((b) => (b.type === 'postback' ? { id: b.payload, title: b.title } : { url: b.url, title: b.title })),
            ig: { button_template: true },
          },
        },
        preview: text,
      };
    }
    case 'list': {
      const { bodyText, headerText, footerText, sections } = send.args;
      const text = joinText(headerText, bodyText, footerText);
      const rows = sections.flatMap((section) => section.rows);
      const choices: QuickReply[] = rows.map((row) => ({ title: row.title, payload: row.id }));
      checkInstagramChoices(target, text, choices, ctx);
      return {
        deliver: (c) => sendInstagramChoices(target, text, choices, c),
        row: {
          content_type: 'interactive',
          content_text: bodyText,
          interactive_payload: {
            kind: 'buttons', body: bodyText, buttons: rows.map(({ id, title }) => ({ id, title })),
            ig: { quick_replies: true },
          },
        },
        preview: bodyText,
      };
    }
  }
}

/**
 * Store the sent message (inside the intent, like the WhatsApp senders) and bump
 * the conversation preview, in one tenant transaction. Meta's echo of this send
 * may already be stored under the same mid; it is replaced by this bot row
 * rather than failing the unique index (which would mark a delivered send 'unknown').
 */
async function persist(accountId: string, conversationId: string, sent: SentMessage, row: Prepared['row'], preview: string): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, async (tx) => {
    // null: another non-echo row already holds this mid; the message was delivered, so the intent stands.
    await storeInstagramSentMessage(tx, {
      accountId,
      conversationId,
      senderType: 'bot',
      senderId: null,
      contentType: row.content_type,
      contentText: row.content_text,
      interactivePayload: row.interactive_payload ?? null,
      messageId: sent.messageId,
    });
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${preview}, last_message_at=now(), updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;
  }, getWorkerPrisma());
}

async function instagramFlowSend(key: string, send: FlowSend): Promise<FlowSendResult> {
  const { accountId, conversationId } = send.args;
  await assertBotRepliesEnabled(accountId, conversationId);
  const ctx: InstagramSendContext = { sender: 'automated', now: new Date() };
  // Worker role: the app role cannot read the token.
  const target = await withTenant({ accountId, role: 'owner' },
    (tx) => loadInstagramTarget(tx, accountId, conversationId), getWorkerPrisma());
  const prepared = await prepare(target, send, ctx);

  const result = await dispatchOnce(accountId, key, async (): Promise<FlowSendResult> => {
    const sent = await prepared.deliver(ctx);
    await persist(accountId, conversationId, sent, prepared.row, prepared.preview);
    return { whatsapp_message_id: sent.messageId, provider_message_id: sent.messageId };
  });

  if (prepared.caption) {
    const caption = prepared.caption;
    try {
      await dispatchOnce(accountId, `${key}:caption`, async (): Promise<FlowSendResult> => {
        const sent = await sendInstagramText(target, caption, ctx);
        await persist(accountId, conversationId, sent, { content_type: 'text', content_text: caption }, caption);
        return { whatsapp_message_id: sent.messageId, provider_message_id: sent.messageId };
      });
    } catch {
      // The media already went out, so the step stands; the caption's intent records what happened.
      console.error('[flows] Instagram caption send failed');
    }
  }
  return result;
}
