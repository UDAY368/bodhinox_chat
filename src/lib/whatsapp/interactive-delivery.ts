import type { DataClient } from '@/lib/data/types'
import { providerMediaUrl } from '@/lib/storage/server'
import type { InteractiveMessagePayload } from './interactive'
import { agentSenderId } from './agent-attribution'
import { sendInteractiveButtons, sendInteractiveList, sendLocationMessage, sendMediaMessage } from './meta-api'

/** One delivery owns its prelude state across recipient variant retries. */
export function createInteractiveDelivery(args: {
  db: DataClient
  accountId: string
  conversationId: string
  senderType: 'agent' | 'bot'
  /** The inbox member sending (messages.sender_id); stored only when senderType is 'agent'. */
  senderId?: string | null
  phoneNumberId: string
  accessToken: string
  payload: InteractiveMessagePayload
  contextMessageId?: string
  replyToMessageId?: string
  beforeSend?: () => Promise<void>
}) {
  let preludeSent = false
  let persistenceFailure: Error | undefined
  let signedMediaUrl: string | undefined
  return {
    async send(to: string): Promise<string> {
      if (persistenceFailure) throw persistenceFailure
      const { payload, accountId, conversationId, senderType, db } = args
      const media = payload.media
      const common = { phoneNumberId: args.phoneNumberId, accessToken: args.accessToken, to, contextMessageId: args.contextMessageId }
      if (media && media.type !== 'location' && !signedMediaUrl) {
        signedMediaUrl = await providerMediaUrl(accountId, media.url)
      }
      if (media && (media.type === 'location' || payload.kind === 'list') && !preludeSent) {
        await args.beforeSend?.()
        const result = media.type === 'location'
          ? await sendLocationMessage({ ...common, location: media })
          : await sendMediaMessage({ ...common, kind: media.type, link: signedMediaUrl!, filename: media.filename })
        preludeSent = true
        const text = media.type === 'location'
          ? [media.name, media.address, `${media.latitude}, ${media.longitude}`].filter(Boolean).join('\n')
          : media.filename || `[${media.type}]`
        try {
          const { error } = await db.from('messages').insert({
          account_id: accountId,
          conversation_id: conversationId,
          sender_type: senderType,
          sender_id: agentSenderId(senderType, args.senderId),
          content_type: media.type,
          content_text: text,
          media_url: media.type === 'location' ? null : media.url,
          message_id: result.messageId,
          status: 'sent',
          reply_to_message_id: args.replyToMessageId || null,
          })
          if (error) throw new Error(error.message)
        } catch (error) {
          persistenceFailure = new Error(`Message sent to Meta but failed to save preceding media: ${error instanceof Error ? error.message : String(error)}`)
          throw persistenceFailure
        }
      }
      await args.beforeSend?.()
      if (payload.kind === 'buttons') {
        const result = await sendInteractiveButtons({ ...common, bodyText: payload.body,
          headerText: payload.header || undefined, footerText: payload.footer || undefined,
          buttons: payload.buttons,
          ...(media && media.type !== 'location' ? { media: { ...media, url: signedMediaUrl! } } : {}),
        })
        return result.messageId
      }
      const result = await sendInteractiveList({ ...common, bodyText: payload.body,
        headerText: payload.header || undefined, footerText: payload.footer || undefined,
        buttonLabel: payload.button_label, sections: payload.sections })
      return result.messageId
    },
  }
}
