import type { ChatMessage } from './types'
import { SENSITIVE_WINDOW } from './assess/classify'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/**
 * Every customer turn since the last assistant/staff turn, at most the
 * newest `window` of them, joined by newlines. Health routing and handoff
 * keywords check this rather than only the latest turn, so a sensitive
 * message followed at once by "hello??" is still caught.
 */
export function recentCustomerText(messages: ChatMessage[], window = SENSITIVE_WINDOW): string {
  const turns: string[] = []
  for (let i = messages.length - 1; i >= 0 && turns.length < window; i--) {
    if (messages[i].role !== 'user') break
    turns.unshift(messages[i].content)
  }
  return turns.length ? turns.join('\n') : latestUserMessage(messages)
}
