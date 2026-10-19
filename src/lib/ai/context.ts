import type { DataClient } from '@/lib/data/types'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type?: string
  interactive_payload?: unknown
}

const MAX_MESSAGE_CHARACTERS = 4000
const MAX_CONTEXT_MESSAGES = 50

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/** Read only customer-visible labels; never serialize actions, IDs or media. */
function visibleText(message: DbMessage): string {
  if (message.content_type && !['text', 'interactive', 'interactive_reply', 'template'].includes(message.content_type)) return ''
  const text = typeof message.content_text === 'string' ? message.content_text.trim() : ''
  if (message.sender_type === 'customer' || message.content_type !== 'interactive') return text.slice(0, MAX_MESSAGE_CHARACTERS)
  const payload = record(message.interactive_payload)
  const parts: string[] = []
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim().slice(0, MAX_MESSAGE_CHARACTERS))
  }
  add(payload.header)
  add(payload.body || text)
  add(payload.footer)
  if (Array.isArray(payload.buttons)) {
    const labels = payload.buttons.slice(0, 10).map(button => record(button).title).filter((label): label is string => typeof label === 'string')
    if (labels.length) add(`Options: ${labels.map(label => label.slice(0, 200)).join(', ')}`)
  }
  add(payload.button_label)
  if (Array.isArray(payload.sections)) {
    for (const section of payload.sections.slice(0, 10)) {
      const group = record(section)
      add(group.title)
      if (Array.isArray(group.rows)) {
        for (const row of group.rows.slice(0, 10)) {
          const option = record(row)
          add(option.title)
          add(option.description)
        }
      }
    }
  }
  return parts.join('\n').slice(0, MAX_MESSAGE_CHARACTERS)
}

/** Recent visible chat history, chronological and bounded for the model. */
export async function buildConversationContext(
  db: DataClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_CONTEXT_MESSAGES, Math.floor(limit))) : aiContextMessageLimit()
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, interactive_payload')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).order('arrival_sequence', { ascending: false })
    .limit(boundedLimit)

  if (error) throw error

  return ((data ?? []) as DbMessage[]).reverse().flatMap(message => {
    const content = visibleText(message)
    return content ? [{ role: message.sender_type === 'customer' ? 'user' as const : 'assistant' as const, content }] : []
  })
}
