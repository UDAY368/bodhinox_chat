import type { DataClient } from '@/lib/data/types'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig } from './types'
import { geminiApiKey } from './gemini-key'
import { aiDeploymentEnabled } from './gate'
import { logAiEvent } from './log'

interface AiConfigRow {
  provider: 'openai' | 'anthropic' | 'openai_compatible' | 'gemini'
  model: string
  base_url: string | null
  api_key: string | null
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

const CONFIG_COLUMNS =
  'provider, model, base_url, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: DataClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  // Deployment kill switch (AI_ENABLED=false): every caller sees "not
  // configured" and takes its existing fallback; no provider is called.
  if (!aiDeploymentEnabled()) return null
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Gemini uses the server environment; other providers retain their
  // encrypted per-account key. A missing key means "not configured".
  const apiKey = row.provider === 'gemini'
    ? geminiApiKey()
    : row.api_key ? decrypt(row.api_key) : ''
  if (!apiKey) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      // Semantic search stays off until the key is re-entered (check ENCRYPTION_KEY).
      logAiEvent({ feature: 'config', reason: 'embeddings_key_undecryptable', accountId })
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKey,
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: DataClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  // Kill switch off: ingest stores chunks without embeddings (FTS still works).
  if (!aiDeploymentEnabled()) return { key: null, corrupt: false }
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    logAiEvent({ feature: 'config', reason: 'embeddings_key_undecryptable', accountId })
    return { key: null, corrupt: true }
  }
}
