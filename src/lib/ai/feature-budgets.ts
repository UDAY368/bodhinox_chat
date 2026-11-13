// Static per-feature budgets for the AI business assistant. Input is
// truncated to maxInputChars before the call, output is capped at
// maxOutputTokens, and the call times out after min(20 s, AI_REQUEST_TIMEOUT_MS).

import { aiRequestTimeoutMs } from './defaults';
import type { AiAssistFeature } from './types';

export interface FeatureBudget {
  /** Total characters of untrusted input sent to the model. */
  maxInputChars: number;
  maxOutputTokens: number;
  /** Recent conversation messages included (0: none). */
  contextMessages: number;
  timeoutMs: number;
}

export const FEATURE_BUDGETS: Record<AiAssistFeature, Omit<FeatureBudget, 'timeoutMs'>> = {
  summary: { maxInputChars: 24_000, maxOutputTokens: 400, contextMessages: 40 },
  suggest: { maxInputChars: 16_000, maxOutputTokens: 300, contextMessages: 20 },
  assess: { maxInputChars: 12_000, maxOutputTokens: 300, contextMessages: 20 },
  // Insights send only the computed numbers (JSON), never conversations.
  insights: { maxInputChars: 8_000, maxOutputTokens: 600, contextMessages: 0 },
  // Auto-labelling reads the first customer messages and returns label names only.
  label: { maxInputChars: 4_000, maxOutputTokens: 80, contextMessages: 6 },
  // Translation of the latest customer messages, or of one staff draft.
  translate: { maxInputChars: 6_000, maxOutputTokens: 700, contextMessages: 6 },
};

export const FEATURE_TIMEOUT_CAP_MS = 20_000;

export function featureBudget(feature: AiAssistFeature): FeatureBudget {
  return { ...FEATURE_BUDGETS[feature], timeoutMs: Math.min(FEATURE_TIMEOUT_CAP_MS, aiRequestTimeoutMs()) };
}

/**
 * A conservative prompt-token bound for `text`: ASCII at characters / 4,
 * every other code point (Devanagari, Tamil, Korean, emoji...) at one token
 * each, since tokenizers spend about one or more tokens per such character.
 */
export function promptTokenBound(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/**
 * The most tokens one call of this feature can spend for this prompt (the
 * pre-call budget check): promptTokenBound plus the output cap. A number is
 * a character count of unknown script, bounded at one token per character.
 */
export function maxTokensFor(feature: AiAssistFeature, prompt: string | number): number {
  const input = typeof prompt === 'string' ? promptTokenBound(prompt) : Math.ceil(Math.max(0, prompt));
  return input + FEATURE_BUDGETS[feature].maxOutputTokens;
}
