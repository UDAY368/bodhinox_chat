// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'openai_compatible' | 'gemini'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` comes from the server environment for Gemini
 * or from the encrypted per-account key for other providers.
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  /** Base URL for OpenAI-compatible providers; null for native providers. */
  baseUrl: string | null
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  /** The WhatsApp inbox auto-reply switch (ai_configs.auto_reply_enabled). */
  autoReplyEnabled: boolean
  /** The Instagram inbox auto-reply switch (Stage 2; absent or false = off). */
  instagramAutoReplyEnabled?: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** True when the model said the knowledge does not cover the question
   *  (NO_ANSWER_SENTINEL, stripped from `text`). */
  noAnswer?: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}

// ------------------------------------------------------------------
// Phase 13: AI business assistant.
// ------------------------------------------------------------------

/** The assistant features that each have a workspace switch (ai_workspace_settings). */
export const AI_ASSIST_FEATURES = ['summary', 'suggest', 'assess', 'insights', 'label', 'translate'] as const
export type AiAssistFeature = (typeof AI_ASSIST_FEATURES)[number]

/** ai_usage_log.mode values (DB CHECK ai_usage_log_mode_check). */
export const AI_USAGE_MODES = ['auto_reply', 'draft', 'summary', 'suggest', 'assess', 'insights', 'label', 'translate'] as const
export type AiUsageMode = (typeof AI_USAGE_MODES)[number]

/** Why an assistant task produced no model output (each has an AiFallback.<reason> message). */
export const AI_FALLBACK_REASONS = [
  'deployment_off', 'not_configured', 'feature_off', 'no_permission', 'quota',
  'timeout', 'provider_error', 'invalid_output', 'guard_blocked',
] as const
export type AiFallbackReason = (typeof AI_FALLBACK_REASONS)[number]

/** Who retrieved knowledge may be shown to: customer-facing text, or staff only. */
export type KnowledgeAudience = 'customer' | 'staff'

/** One knowledge chunk that grounded an answer, as shown next to it. */
export interface KnowledgeCitation {
  chunk_id: string
  document_id: string | null
  source_id: string | null
  title: string | null
  source_url: string | null
}

/** Untrusted text handed to a model, always delimited as data (safety/untrusted.ts). */
export interface UntrustedBlock {
  source: 'customer' | 'knowledge' | 'crm'
  text: string
  /** Optional short label shown inside the block (e.g. "transcript", a document title). */
  label?: string
}
