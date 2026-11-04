import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { buildConversationContext } from '@/lib/ai/context';
import { retrieveKnowledgeScored } from '@/lib/ai/knowledge';
import { generateReply } from '@/lib/ai/generate';
import { buildAgentSystemPrompt, loadAgentProfile, type AgentProfile } from '@/lib/ai/agent-profile';
import { latestUserMessage, recentCustomerText } from '@/lib/ai/query';
import { logAiUsage, promptCharsOf } from '@/lib/ai/usage';
import { logAiEvent } from '@/lib/ai/log';
import { aiDeploymentEnabled } from '@/lib/ai/gate';
import { databaseAdmin } from '@/lib/ai/admin-client';
import { classifySensitive } from '@/lib/ai/safety/sensitive';
import { guardCustomerText, isHealthWorkspace, redactChat, urlAllowlist } from '@/lib/ai/assist/guards';
import { AiError } from '@/lib/ai/types';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { recordAiMessage, requireAiMessageRoom } from '@/lib/billing/limits';

const t = getT('Api');

/**
 * POST /api/ai/draft  (agent+, 'ai.assist')
 *
 * Body: { conversation_id }
 * Returns: { draft, citations } — a suggested reply for the agent to edit + send.
 *
 * Uses the account's configured provider/key (BYO). Read-only: it never
 * sends or stores anything, just hands text back to the composer.
 *
 * Guards (Phase 13):
 *  - a health or other sensitive latest customer message gets no draft at
 *    all: 200 { draft: null, code: 'route_to_staff', categories } (no
 *    provider call);
 *  - customer messages are redacted before the call; knowledge is the
 *    customer-facing audience only;
 *  - a draft that asserts a payment, refund, attendance, shipment or
 *    delivery status, or gives medical advice, is withheld:
 *    422 { code: 'guard_blocked' }; links that are not allowed are removed;
 *  - the deployment kill switch off: 503 { code: 'ai_disabled' }.
 * Only reason codes are logged, never customer text, prompts or output.
 */
export async function POST(request: Request) {
  try {
    const { db, accountId, userId, role } = await requireRole('agent');
    // Workspaces can turn the AI assistant (drafts included) off per role.
    await requirePermission({ accountId, userId, role }, 'ai.assist');

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    // Also cap the whole team's draws on the shared BYO provider key.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body.conversation_id === 'string'
        ? body.conversation_id
        : '';
    if (!conversationId) {
      return NextResponse.json(
        { error: t('ai.conversationIdRequired') },
        { status: 400 }
      );
    }

    // RLS scopes the SSR client to the caller's account, so a missing
    // row means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await db
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) {
      logAiEvent({ feature: 'draft', reason: 'conversation_lookup_failed', accountId });
      return NextResponse.json(
        { error: t('common.failedToLoadConversation') },
        { status: 500 }
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { error: t('common.conversationNotFound') },
        { status: 404 }
      );
    }

    // Emergency kill switch: no provider call (and no paid retrieval embedding).
    if (!aiDeploymentEnabled()) {
      throw new AiError('AI is turned off on this deployment.', { code: 'ai_disabled', status: 503 });
    }

    const config = await loadAiConfig(db, accountId).catch((err) => {
      // Decrypt failure — surface distinctly from "not configured".
      logAiEvent({ feature: 'draft', reason: 'config_load_failed', accountId, error: err });
      throw new AiError(t('ai.storedKeyUndecryptable'), {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config) {
      return NextResponse.json(
        {
          error: t('ai.notConfigured'),
          code: 'ai_not_configured',
        },
        { status: 400 }
      );
    }

    const messages = await buildConversationContext(db, conversationId);
    // Nothing to draft from — a brand-new thread with no customer text
    // would otherwise produce a nonsensical reply-to-nothing.
    if (messages.length === 0) {
      return NextResponse.json(
        {
          error: t('ai.noMessages'),
          code: 'no_messages',
        },
        { status: 400 }
      );
    }

    // A health or safety-sensitive question is answered by qualified staff,
    // never drafted by the model (checked before any provider call).
    // Every customer turn since the last reply is checked, so a burst is still routed.
    const question = latestUserMessage(messages);
    const sensitive = classifySensitive(recentCustomerText(messages));
    if (sensitive.sensitive) {
      logAiEvent({ feature: 'draft', reason: 'sensitive_topic', accountId });
      return NextResponse.json({ draft: null, code: 'route_to_staff', categories: sensitive.categories });
    }

    // Ground the draft in the account's customer-facing knowledge
    // (best-effort — empty when there's no KB or retrieval fails).
    const knowledge = await retrieveKnowledgeScored(db, accountId, config, question, 5, 'customer');
    const excerpts = knowledge.chunks.map((c) => c.content);

    // Same prompt as the live agent: the workspace's agent profile (its
    // business context and instructions), else the legacy system prompt
    // unchanged. The profile is read best-effort, like auto-reply.
    const profile: AgentProfile | null = await loadAgentProfile({ accountId, userId, role }).catch(() => null);
    const systemPrompt = buildAgentSystemPrompt(profile, {
      mode: 'draft',
      knowledge: excerpts,
      legacyPrompt: config.systemPrompt,
    });
    const healthWorkspace = await withTenant({ accountId, userId, role }, (tx) => isHealthWorkspace(tx, accountId, profile))
      .catch(() => true);

    // The plan's monthly AI messages (402 with an upgrade hint when used up).
    await requireAiMessageRoom(accountId);
    const redacted = redactChat(messages);
    const { text, usage } = await generateReply({
      config,
      systemPrompt,
      messages: redacted.messages,
    });
    await recordAiMessage(accountId);

    // Record spend on the account's BYO key. Best-effort + via the
    // service role (the log has no `authenticated` INSERT policy). This
    // must not fail or delay the draft the agent is waiting on, so:
    //  - the whole thing is wrapped (constructing the admin client throws
    //    if the service-role key is unset — that must not 500 the draft);
    //  - it's fire-and-forget (`void`), not awaited, so the response
    //    isn't held for a DB round-trip.
    try {
      void logAiUsage(databaseAdmin({ accountId, userId, role: 'agent' }), {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
        estimate: { promptChars: promptCharsOf(systemPrompt, redacted.messages), outputChars: text.length },
      });
    } catch (logErr) {
      logAiEvent({ feature: 'draft', reason: 'usage_log_skipped', accountId, error: logErr });
    }

    const guarded = guardCustomerText(text, {
      allow: urlAllowlist({ citations: knowledge.citations, profile, legacyPrompt: config.systemPrompt }),
      healthWorkspace,
    });
    if (!guarded.ok) {
      logAiEvent({ feature: 'draft', reason: 'guard_blocked', accountId, flags: guarded.flags });
      return NextResponse.json({ draft: null, code: 'guard_blocked', error: 'guard_blocked' }, { status: 422 });
    }
    const flags = [...guarded.flags, ...(redacted.redacted ? ['pii_redacted'] : [])];
    if (flags.length) logAiEvent({ feature: 'draft', reason: 'ok', accountId, flags });

    return NextResponse.json({ draft: guarded.text, citations: knowledge.citations });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
