// 'conversation' context: the recent visible transcript of one conversation.
//
// Only customer-visible text is read (text, buttons and list labels the
// customer saw, template bodies). Media becomes a "[image]" style marker;
// ids, actions and URLs of media are never included. Every line is untrusted
// customer data: runAiTask delimits and redacts it before any model call.

import { conversationVisible } from '@/lib/inbox/visibility-sql';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { UntrustedBlock } from '../types';
import { SENSITIVE_WINDOW } from '../assess/classify';
import { emptyContext, type ContextProvider, type ContextRequest, type ContextResult } from './core';
import { withRequestTenant } from './scope';

export type TranscriptSender = 'customer' | 'agent' | 'bot';

export interface TranscriptMessage {
  id: string;
  sender: TranscriptSender;
  text: string;
  at: string;
}

export interface Transcript {
  conversationId: string;
  contactId: string;
  channel: string;
  /** Chronological, at most the requested number of messages. */
  messages: TranscriptMessage[];
}

const MAX_MESSAGE_CHARS = 2_000;
const MAX_MESSAGES = 50;
const TEXT_TYPES = new Set(['text', 'interactive', 'interactive_reply', 'template', 'button']);

interface MessageRow {
  id: string;
  sender_type: string;
  content_type: string | null;
  content_text: string | null;
  interactive_payload: unknown;
  created_at: Date | null;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The text a message showed, or a marker for media. Never ids, URLs or actions. */
export function visibleMessageText(row: Pick<MessageRow, 'content_type' | 'content_text' | 'interactive_payload'>): string {
  const type = row.content_type ?? 'text';
  const text = typeof row.content_text === 'string' ? row.content_text.trim() : '';
  if (!TEXT_TYPES.has(type)) return text ? `[${type}] ${text}`.slice(0, MAX_MESSAGE_CHARS) : `[${type}]`;
  if (text) return text.slice(0, MAX_MESSAGE_CHARS);
  const body = record(row.interactive_payload).body;
  return typeof body === 'string' ? body.trim().slice(0, MAX_MESSAGE_CHARS) : '';
}

const senderOf = (value: string): TranscriptSender => (value === 'customer' ? 'customer' : value === 'bot' ? 'bot' : 'agent');

/** Reads the transcript inside the caller's tenant transaction. Null when the conversation is not this workspace's. */
export async function readTranscript(
  tx: TenantTransaction,
  accountId: string,
  conversationId: string,
  maxMessages: number,
): Promise<Transcript | null> {
  const [conversation] = await tx.$queryRaw<{ id: string; contact_id: string; channel: string | null }[]>`
    SELECT id, contact_id, channel FROM conversations WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid
      AND ${conversationVisible('conversations')}`;
  if (!conversation) return null;
  const limit = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(maxMessages) || 1));
  const rows = await tx.$queryRaw<MessageRow[]>`
    SELECT id, sender_type, content_type, content_text, interactive_payload, created_at FROM messages
    WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid
    ORDER BY created_at DESC, arrival_sequence DESC LIMIT ${limit}`;
  const messages = rows.reverse().flatMap((row) => {
    const text = visibleMessageText(row);
    return text ? [{ id: row.id, sender: senderOf(row.sender_type), text, at: (row.created_at ?? new Date(0)).toISOString() }] : [];
  });
  return { conversationId: conversation.id, contactId: conversation.contact_id, channel: conversation.channel ?? 'whatsapp', messages };
}

/** The transcript for a context request, or null when the conversation is not visible to the requester. */
export function loadTranscript(request: ContextRequest): Promise<Transcript | null> {
  if (!request.conversationId) return Promise.resolve(null);
  const conversationId = request.conversationId;
  return withRequestTenant(request, (tx) => readTranscript(tx, request.accountId, conversationId, request.maxMessages ?? 20));
}

/** The latest customer turn (empty when the customer has not written). */
export function latestCustomerText(transcript: Transcript): string {
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    if (transcript.messages[i].sender === 'customer') return transcript.messages[i].text;
  }
  return '';
}

/** Customer turns since the last staff/bot turn (newest `window`), joined: what health routing checks. */
export function recentCustomerTextOf(transcript: Transcript, window = SENSITIVE_WINDOW): string {
  const turns: string[] = [];
  for (let i = transcript.messages.length - 1; i >= 0 && turns.length < window; i--) {
    if (transcript.messages[i].sender !== 'customer') break;
    turns.unshift(transcript.messages[i].text);
  }
  return turns.length ? turns.join('\n') : latestCustomerText(transcript);
}

const LABEL: Record<TranscriptSender, string> = { customer: 'Customer', agent: 'Staff', bot: 'Automated reply' };

/** The transcript as one untrusted customer block (the newest text is kept when truncated). */
export function transcriptBlock(transcript: Transcript): UntrustedBlock {
  const text = transcript.messages.map((m) => `[${m.at.slice(0, 16).replace('T', ' ')}] ${LABEL[m.sender]}: ${m.text}`).join('\n');
  return { source: 'customer', label: 'transcript', text };
}

export function transcriptContext(transcript: Transcript): ContextResult {
  const out = emptyContext();
  if (transcript.messages.length) out.blocks.push(transcriptBlock(transcript));
  out.sourceMessageIds.push(...transcript.messages.map((m) => m.id));
  out.facts.message_count = transcript.messages.length;
  out.facts.customer_message_count = transcript.messages.filter((m) => m.sender === 'customer').length;
  const lastCustomer = [...transcript.messages].reverse().find((m) => m.sender === 'customer');
  out.facts.last_customer_message_at = lastCustomer?.at ?? null;
  return out;
}

export const conversationProvider: ContextProvider = {
  key: 'conversation',
  minRole: 'agent',
  audiences: ['customer', 'staff'],
  async load(request) {
    const transcript = await loadTranscript(request);
    return transcript ? transcriptContext(transcript) : emptyContext();
  },
};
