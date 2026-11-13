import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { assertWhatsAppConversation, NoNumberError } from '@/lib/whatsapp/numbers';
import { loadSenderConfig, numberErrorText, type SenderConfigRow } from '@/lib/whatsapp/sender-config';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { manualRepliesBlocked } from '@/lib/platform/lifecycle';
import { INSTAGRAM_REACTION, instagramReactionIntent } from '@/lib/instagram/reaction-emoji';

const t = getT('Api');

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    // Reacting is a write operation (`canSendMessages`), and it pushes the
    // reaction to Meta before mirroring it locally — so, as on /send, a
    // missing role check let a read-only viewer put a visible reaction on
    // the customer's message even though RLS blocked the local mirror.
    const { db, accountId, userId, role } = await requireRole('agent');

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // A reaction is a manual agent message: refused while a platform admin blocks manual replies.
    if (await manualRepliesBlocked({ accountId, userId, role })) {
      return NextResponse.json({ error: t('send.manualBlocked'), code: 'workspace_manual_blocked' }, { status: 403 });
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: t('react.idEmojiRequired') },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const { data: targetMessage, error: msgError } = await db
      .from('messages')
      .select('id, message_id, conversation_id')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: t('react.messageNotFound') }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: t('react.notSent') },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await db
      .from('conversations')
      .select('id, account_id, whatsapp_config_id, channel, contact:contacts(phone, wa_user_id)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: t('common.conversationNotFound') },
        { status: 404 },
      );
    }

    // Instagram: the heart only (Meta's single "love" reaction), through the
    // Instagram sender; never from the default WhatsApp number.
    if ((conversation as { channel?: string | null }).channel === 'instagram') {
      const intent = instagramReactionIntent(emoji);
      if (!intent) {
        return NextResponse.json({ error: t('react.instagramHeartOnly'), code: 'channel_not_supported' }, { status: 409 });
      }
      // Loaded only for Instagram conversations, so the WhatsApp path's module graph is unchanged.
      const [{ instagramConfig }, { InstagramError }, { instagramErrorResponse }, { reactOnInstagram }, { MetaApiError }] = await Promise.all([
        import('@/lib/instagram/config'), import('@/lib/instagram/errors'), import('@/lib/instagram/http'),
        import('@/lib/instagram/reactions'), import('@/lib/whatsapp/meta-api'),
      ]);
      if (!instagramConfig()) return instagramErrorResponse('instagram_not_enabled');
      try {
        await reactOnInstagram({ accountId, conversationId: conversation.id, mid: targetMessage.message_id, react: intent === 'react' });
      } catch (err) {
        if (err instanceof InstagramError) return instagramErrorResponse(err.code);
        if (err instanceof MetaApiError) {
          console.error('[instagram/react] Meta send failed');
          return NextResponse.json({ error: t('react.metaError', { message: 'Instagram' }) }, { status: 502 });
        }
        throw err;
      }
      return mirrorReaction(db, targetMessage, userId, intent === 'react' ? INSTAGRAM_REACTION : '');
    }

    // WhatsApp: never react from the default number on another channel.
    try {
      assertWhatsAppConversation(conversation as { channel: string | null | undefined });
    } catch (error) {
      if (error instanceof NoNumberError) {
        return NextResponse.json({ error: numberErrorText(error), code: 'channel_not_supported' }, { status: 409 });
      }
      throw error;
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    // Phone number, or the business-scoped user ID for a contact Meta
    // never gave us a number for (issue #519).
    const sendTarget = resolveContactSendTarget(contact);
    if (!sendTarget) {
      return NextResponse.json(
        { error: t('react.contactNoPhone') },
        { status: 400 },
      );
    }

    // React from the number the conversation is on (the default for a
    // legacy conversation without one). Account-scoped.
    let config: SenderConfigRow;
    try {
      config = await loadSenderConfig(
        db,
        accountId,
        (conversation as { whatsapp_config_id?: string | null }).whatsapp_config_id ?? null,
      );
    } catch (error) {
      if (error instanceof NoNumberError && error.reason === 'disconnected') {
        return NextResponse.json({ error: numberErrorText(error), code: 'whatsapp_number_disconnected' }, { status: 409 });
      }
      if (error instanceof NoNumberError && error.reason !== 'none') {
        return NextResponse.json({ error: numberErrorText(error) }, { status: 400 });
      }
      return NextResponse.json(
        { error: t('common.whatsappNotConfiguredDot') },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: sendTarget.target,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('react.unknownMetaError');
      console.error('[whatsapp/react] Meta send failed:', message);
      return NextResponse.json(
        { error: t('react.metaError', { message }) },
        { status: 502 },
      );
    }

    return mirrorReaction(db, targetMessage, userId, emoji);
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp react POST:', error);
    return toErrorResponse(error);
  }
}

type ReactDb = Awaited<ReturnType<typeof requireRole>>['db'];

/** Mirror the member's reaction into message_reactions (empty emoji removes it). */
async function mirrorReaction(
  db: ReactDb,
  targetMessage: { id: string; conversation_id: string },
  userId: string,
  emoji: string,
) {
  // Mirror into DB. Empty emoji = removal.
  if (emoji === '') {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetMessage.id)
      .eq('actor_type', 'agent')
      .eq('actor_id', userId);

    if (delError) {
      console.error('[whatsapp/react] DB delete failed:', delError.message);
      return NextResponse.json(
        { error: t('react.dbDeleteFailed') },
        { status: 500 },
      );
    }
  } else {
    // Upsert. The unique constraint (message_id, actor_type, actor_id)
    // lets us swap emoji in a single statement.
    const { error: upsertError } = await db.from('message_reactions').upsert(
      {
        message_id: targetMessage.id,
        conversation_id: targetMessage.conversation_id,
        actor_type: 'agent',
        actor_id: userId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    );

    if (upsertError) {
      console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
      return NextResponse.json(
        { error: t('react.dbUpsertFailed') },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ success: true });
}
