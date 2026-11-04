// The context-provider registry and types (see index.ts for the built-in
// providers). Fixed, read-only providers fetch context BEFORE a model call;
// the model has no tools and no provider ever takes model output as input.
// Each provider declares the lowest role and the audiences it may serve, and
// loadContext enforces both. What a provider returns is data: untrusted text
// goes into UntrustedBlocks (delimited and redacted by runAiTask), statuses
// are labelled as records.

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import type { KnowledgeAudience, KnowledgeCitation, UntrustedBlock } from '../types';

export const CONTEXT_PROVIDER_KEYS = [
  'conversation', 'contactBasics', 'openDeal', 'orderStatus', 'appointmentStatus', 'knowledge', 'insightData',
] as const;
export type ContextProviderKey = (typeof CONTEXT_PROVIDER_KEYS)[number];

export interface ContextRequest {
  accountId: string;
  userId: string | null;
  role: AccountRole;
  audience: KnowledgeAudience;
  conversationId?: string;
  contactId?: string;
  /** Retrieval query (knowledge). */
  query?: string;
  /** Most recent messages to include (conversation). */
  maxMessages?: number;
  /** Insight key and date range (insightData). */
  insight?: { key: string; from: string; to: string };
}

export interface ContextResult {
  /** Untrusted text for the model (always delimited and redacted by runAiTask). */
  blocks: UntrustedBlock[];
  citations: KnowledgeCitation[];
  /** Message ids the blocks were built from (evidence for assessments). */
  sourceMessageIds: string[];
  /** Structured facts (numbers, statuses, flags), labelled as data, never instructions. */
  facts: Record<string, string | number | boolean | null>;
  /** When the data was read (ISO timestamp). */
  dataAsOf: string;
}

export interface ContextProvider {
  key: ContextProviderKey;
  /** Lowest role that may load this context. */
  minRole: AccountRole;
  /** Audiences this context may serve ('orderStatus' and 'appointmentStatus' are staff-only). */
  audiences: readonly KnowledgeAudience[];
  load(request: ContextRequest): Promise<ContextResult>;
}

export function emptyContext(at: Date = new Date()): ContextResult {
  return { blocks: [], citations: [], sourceMessageIds: [], facts: {}, dataAsOf: at.toISOString() };
}

const registry = new Map<ContextProviderKey, ContextProvider>();

export function registerContextProvider(provider: ContextProvider): void {
  registry.set(provider.key, provider);
}

export function getContextProvider(key: ContextProviderKey): ContextProvider | undefined {
  return registry.get(key);
}

export class ContextAccessError extends Error {
  constructor(readonly key: ContextProviderKey, readonly reason: 'unknown_provider' | 'role' | 'audience') {
    super(`Context provider ${key} refused: ${reason}`);
    this.name = 'ContextAccessError';
  }
}

/** Loads and merges the given providers' context, enforcing each one's role and audience. */
export async function loadContext(keys: readonly ContextProviderKey[], request: ContextRequest): Promise<ContextResult> {
  const out = emptyContext();
  for (const key of keys) {
    const provider = registry.get(key);
    if (!provider) throw new ContextAccessError(key, 'unknown_provider');
    if (!hasMinRole(request.role, provider.minRole)) throw new ContextAccessError(key, 'role');
    if (!provider.audiences.includes(request.audience)) throw new ContextAccessError(key, 'audience');
    const result = await provider.load(request);
    out.blocks.push(...result.blocks);
    out.citations.push(...result.citations);
    out.sourceMessageIds.push(...result.sourceMessageIds);
    Object.assign(out.facts, result.facts);
    if (result.dataAsOf < out.dataAsOf) out.dataAsOf = result.dataAsOf;
  }
  return out;
}
