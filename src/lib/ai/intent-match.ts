// Stage 5 (5G): "match meaning" keyword triggers. 5B calls intentMatches after
// every exact trigger failed and before default_reply.
//
// One classification call per inbound message covers every candidate intent
// flow. The call runs under an outbound intent keyed by the message id
// (`ai-intent:<messageId>`), so its answer is stored once and every retry or
// second process reads the stored answer instead of calling (and billing) the
// model again; an earlier attempt that stopped mid-call is treated as no match.
// A short in-process cache saves the database round trip for the same message.
//
// No match on anything unusual: AI off or not configured, the deployment
// switch off, the plan's AI budget used up, a timeout, a provider error or an
// answer that is not one of the listed numbers. The default reply still
// applies then. Customer text, intents and model output are never logged.

import { databaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { chatTokenEstimate, failAi, reserveAi, settleAi } from './budget';
import { generateReply } from './generate';
import { logAiEvent } from './log';
import { usageLog } from './usage';
import { redactForProvider } from './safety/redact';
import { delimitUntrusted } from './safety/untrusted';
import { aiDeploymentEnabled } from './gate';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { FLOW_TRIGGER_LIMITS } from '@/lib/flows/types';

/** A flow whose keyword trigger uses `match_type: "intent"`. */
export interface IntentCandidate {
  flowId: string;
  /** The intent sentence (≤ FLOW_TRIGGER_LIMITS.intentChars). */
  intent: string;
}

/** The whole classification (database and model) gives up after this long: no match. */
export const INTENT_TIMEOUT_MS = 4_000;
/** Candidates sent in one call; more than this are ignored (the first ones by the caller's precedence). */
export const INTENT_MAX_CANDIDATES = 20;
/** Customer text sent to the model. */
export const INTENT_MAX_TEXT = 1_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cache = new Map<string, { at: number; value: Promise<string | null> }>();

/** Test hook: forget cached answers. */
export function clearIntentCacheForTests(): void {
  cache.clear();
}

/**
 * The candidates worth sending: valid flow ids, a non-empty intent (trimmed
 * and capped), duplicates by flow dropped, at most INTENT_MAX_CANDIDATES.
 */
export function usableCandidates(candidates: readonly IntentCandidate[]): IntentCandidate[] {
  const seen = new Set<string>();
  const out: IntentCandidate[] = [];
  for (const c of candidates) {
    if (!c || typeof c.flowId !== 'string' || !UUID.test(c.flowId) || seen.has(c.flowId)) continue;
    const intent = typeof c.intent === 'string' ? c.intent.replace(/\s+/g, ' ').trim().slice(0, FLOW_TRIGGER_LIMITS.intentChars) : '';
    if (!intent) continue;
    seen.add(c.flowId);
    out.push({ flowId: c.flowId, intent });
    if (out.length >= INTENT_MAX_CANDIDATES) break;
  }
  return out;
}

/** The fixed instructions: numbered intents (the flow author's own text), answer one number. */
export function intentSystemPrompt(candidates: readonly IntentCandidate[], instruction: string): string {
  return [
    'You classify one customer message for a business inbox. Decide which numbered intent the message clearly expresses.',
    'Intents:',
    ...candidates.map((c, i) => `${i + 1}. ${c.intent.replace(/[\r\n]+/g, ' ')}`),
    'Answer with the number of the single best matching intent, or 0 when none clearly matches. Output the number only.',
    instruction,
  ].join('\n');
}

/** The chosen candidate's index from the model's answer, or null (0, out of range or not a number). */
export function parseIntentAnswer(text: string, count: number): number | null {
  const match = /^\s*(\d{1,3})\s*\.?\s*$/.exec(text.replace(/[`*"']/g, ''));
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= count ? n - 1 : null;
}

/** What the intent stores: the matched flow id or null. Never the text. */
interface StoredAnswer { flow_id: string | null }

/** Runs `work` but answers `fallback` after `ms`. The work is not cancelled (its intent completes on its own). */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([work.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * One customer message against the candidates: one model call, stored under
 * its own outbound intent. Null on any refusal or failure. Never throws.
 */
async function classify(accountId: string, messageId: string, text: string, candidates: IntentCandidate[]): Promise<string | null> {
  try {
    const stored = await dispatchOnce<StoredAnswer>(accountId, `ai-intent:${messageId}`, async () => {
      const config = await loadAiConfig(databaseAdmin({ accountId, role: 'owner' }), accountId);
      if (!config) return { flow_id: null };
      const redacted = redactForProvider(text.slice(0, INTENT_MAX_TEXT)).text;
      const delimited = delimitUntrusted([{ source: 'customer', label: 'message', text: redacted }]);
      const systemPrompt = intentSystemPrompt(candidates, delimited.instruction);
      const messages = [{ role: 'user' as const, content: delimited.text }];
      let reservation;
      try {
        // One meter per inbound message, however often it is replayed.
        reservation = await reserveAi(accountId, `intent:${messageId}`, { message: false, tokens: chatTokenEstimate(systemPrompt, messages, 16) });
      } catch (error) {
        if (error instanceof PlanLimitError) return { flow_id: null };
        throw error;
      }
      let generated: Awaited<ReturnType<typeof generateReply>>;
      try {
        generated = await generateReply({ config, systemPrompt, messages, maxOutputTokens: 16, timeoutMs: INTENT_TIMEOUT_MS });
      } catch (error) {
        await failAi(reservation, error, systemPrompt.length + delimited.text.length);
        logAiEvent({ feature: 'intent_match', reason: 'provider_error', accountId, error });
        return { flow_id: null };
      }
      const log = usageLog({
        conversationId: null, mode: 'auto_reply', provider: config.provider, model: config.model, usage: generated.usage,
        estimate: { promptChars: systemPrompt.length + delimited.text.length, outputChars: generated.text.length },
      });
      await settleAi(reservation, { tokens: log.totalTokens, log });
      const index = parseIntentAnswer(generated.text, candidates.length);
      return { flow_id: index === null ? null : candidates[index].flowId };
    });
    const flowId = stored?.flow_id ?? null;
    // A stored answer is only trusted while that flow is still a candidate.
    return flowId && candidates.some((c) => c.flowId === flowId) ? flowId : null;
  } catch (error) {
    // An earlier attempt left the intent open (UncertainDispatchError), a dry run, or a database failure: no match.
    logAiEvent({ feature: 'intent_match', reason: 'unavailable', accountId, error });
    return null;
  }
}

/** The id of the flow whose intent the message matches, or null. */
export async function intentMatches(accountId: string, messageId: string, text: string,
  candidates: readonly IntentCandidate[]): Promise<string | null> {
  const usable = usableCandidates(candidates);
  if (!usable.length || typeof text !== 'string' || !text.trim() || !messageId || !aiDeploymentEnabled()) return null;
  const key = `${accountId}:${messageId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS || cache.size >= CACHE_MAX) cache.delete(k);
  }
  const value = withTimeout(classify(accountId, messageId, text, usable), INTENT_TIMEOUT_MS, null);
  cache.set(key, { at: now, value });
  return value;
}
