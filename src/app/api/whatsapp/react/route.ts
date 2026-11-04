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
    const { db, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
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

    // Reactions are WhatsApp only (Instagram reactions are deferred): never
    // react from the default number on an Instagram conversation.
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
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp react POST:', error);
    return toErrorResponse(error);
  }
}
