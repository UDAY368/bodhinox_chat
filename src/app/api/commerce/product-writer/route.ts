// POST /api/commerce/product-writer { name, attributes?: string[] (up to 10), tone: friendly|professional|playful|luxury|simple }
//   (admins, the role that edits products). 200 { description }: a DRAFT for the product editor. It never saves a product. The prompt holds
//   only those inputs (no customer data). Uses the workspace's AI provider and is billed as one AI message per request (the plan's AI
//   message and token limits and the workspace token cap are checked before the model is called). Inputs and output are never logged.
//   400 { code: 'invalid' }; 400 { code: 'ai_not_configured' }; 402/429 limits; 422 unusable model output.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadAiConfig } from '@/lib/ai/config';
import { requestMeter, ROUTE_GENERATION_TOKENS } from '@/lib/ai/budget';
import { parseWriterInput, writeProductDescription } from '@/lib/ai/product-writer';
import { AiError } from '@/lib/ai/types';
import { getT } from '@/lib/i18n/translate';
import { readBody } from '@/lib/commerce/marketing-http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const t = getT('Api');

export async function POST(request: Request) {
  try {
    const { db, accountId, userId } = await requireRole('admin');
    const userLimit = checkRateLimit(`ai-product-writer:${userId}`, RATE_LIMITS.aiDraft);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const input = parseWriterInput(await readBody(request));
    if (!input) return NextResponse.json({ error: t('aiAssist.writerInvalid'), code: 'invalid' }, { status: 400 });

    const config = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => {
      throw new AiError(t('ai.storedKeyUndecryptable'), { code: 'key_decrypt_failed', status: 400 });
    });
    if (!config) return NextResponse.json({ error: t('ai.noAgentConfigured'), code: 'ai_not_configured' }, { status: 400 });

    // One AI message per request (a corrective retry included), held before the first model call and settled once.
    const meter = requestMeter(accountId, ROUTE_GENERATION_TOKENS, { conversationId: null, mode: 'draft', provider: config.provider, model: config.model });
    const description = await writeProductDescription({ config, input, hooks: meter.hooks }).catch(async (error: unknown) => {
      await meter.finish(error);
      throw error;
    });
    await meter.finish();
    return NextResponse.json({ description }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof AiError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    return toErrorResponse(err);
  }
}
