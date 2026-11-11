import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getTemplate, templateOnChannel } from '@/lib/automations/templates';
import {
  insertSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  channelPaletteIssues,
  parseAutomationChannel,
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';
import { automationTemplateIssues } from '@/lib/automations/template-check';
import { getT } from '@/lib/i18n/translate';
import { requireScheduledSendingAllowed } from '@/lib/automations/schedule-gate';
import { hasMinRole } from '@/lib/auth/roles';
import {
  addsSecretWebhook,
  channelPaletteRefusal,
  invalidChannelRefusal,
  loopRefusal,
  publishChecks,
} from '@/lib/automations/publish-checks';
import { activateWithLoopLock } from '@/lib/automations/activation-lock';
import { tenantOf } from '@/lib/audience/http';

const t = getT('Api');
const tChannel = getT('Automations.channelSection');
const tChannelNames = getT('Channels.names');

/**
 * Lists the workspace's automations. `?channel=whatsapp|instagram` returns one
 * channel's section; without it every automation is returned, as before
 * channels (API-key and mcp-server clients).
 */
export async function GET(request: Request) {
  const param = new URL(request.url).searchParams.get('channel');
  const channel = param === null ? null : parseAutomationChannel(param);
  if (param !== null && !channel) return invalidChannelRefusal();
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: t('common.unauthorized') },
      { status: 401 }
    );

  const query = db.from('automations').select('*');
  const { data, error } = await (channel ? query.eq('channel', channel) : query)
    .order('created_at', { ascending: false });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ automations: data ?? [] });
}

export async function POST(request: Request) {
  // Use the authenticated tenant client; role and RLS both apply.
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: t('common.unauthorized') },
      { status: 401 }
    );

  // Use the authenticated tenant client; role and RLS both apply.
  const { data: profile } = await db
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: t('common.profileNotLinked') },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json(
      { error: t('common.invalidJson') },
      { status: 400 }
    );

  const {
    name,
    description,
    trigger_type,
    trigger_config,
    is_active,
    steps,
    template,
  } = body;

  // The section the automation belongs to, fixed for its life. Absent means
  // WhatsApp, as for every client written before channels; the UI always sends it.
  const channel = parseAutomationChannel(body.channel);
  if (!channel) return invalidChannelRefusal();

  let effectiveSteps: BuilderStepInput[] | undefined = steps;
  let effectiveName = name;
  let effectiveDescription = description;
  let effectiveTriggerType = trigger_type;
  let effectiveTriggerConfig = trigger_config;

  if (template && (!steps || steps.length === 0)) {
    const tpl = getTemplate(template);
    if (tpl && !templateOnChannel(tpl, channel)) {
      const message = tChannel('unavailableOnChannel', { channel: tChannelNames(channel) });
      return channelPaletteRefusal([{ path: 'template', message }]);
    }
    if (tpl) {
      effectiveName = effectiveName ?? tpl.name;
      effectiveDescription = effectiveDescription ?? tpl.description;
      effectiveTriggerType = effectiveTriggerType ?? tpl.trigger_type;
      effectiveTriggerConfig = effectiveTriggerConfig ?? tpl.trigger_config;
      effectiveSteps = tpl.steps as unknown as BuilderStepInput[];
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: t('automations.nameTriggerRequired') },
      { status: 400 }
    );
  }

  // Only the channel's triggers and steps, on any save (the builder offers no others).
  const paletteIssues = channelPaletteIssues(channel, effectiveTriggerType, effectiveSteps);
  if (paletteIssues.length > 0) return channelPaletteRefusal(paletteIssues);

  // A template step that needs more than body values would fail on
  // every run, so it is refused on any save, draft or active.
  const templateIssues = await automationTemplateIssues(
    db,
    accountId,
    effectiveSteps
  );
  if (templateIssues.length > 0) {
    return NextResponse.json(
      { error: templateIssues[0].message, issues: templateIssues },
      { status: 400 }
    );
  }

  // A secret workspace value in a webhook step is admin-only, draft or active.
  if (
    !hasMinRole(ctx.role, 'admin') &&
    (await addsSecretWebhook(accountId, effectiveSteps ?? [], []))
  ) {
    return NextResponse.json(
      { error: t('automations.secretNeedsAdmin') },
      { status: 403 }
    );
  }

  // Block activation of a clearly broken automation up-front instead of
  // letting every trigger silently produce a failed log row. Drafts
  // (is_active=false) are allowed to be incomplete so users can save
  // progress mid-build.
  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(
        effectiveTriggerType,
        effectiveTriggerConfig ?? {},
        effectiveSteps ?? [],
        channel
      ),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[],
        channel
      ),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        { error: t('automations.invalidActivateConfig'), issues },
        { status: 400 }
      );
    }
    const published = await publishChecks(ctx, accountId, {
      channel,
      name: effectiveName,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      steps: effectiveSteps ?? [],
    });
    if (published) return published;
    try {
      // The plan's active-automation cap is checked under the activation lock below.
      await requireScheduledSendingAllowed(
        accountId,
        effectiveTriggerType,
        effectiveSteps ?? []
      );
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  const admin = db;
  const { data: automation, error: insertErr } = await admin
    .from('automations')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: effectiveName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      channel,
      // Turned on below, under the per-account loop lock, once its steps exist.
      is_active: false,
    })
    .select()
    .single();

  if (insertErr || !automation) {
    return NextResponse.json(
      { error: insertErr?.message ?? t('common.insertFailed') },
      { status: 500 }
    );
  }

  if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.id, effectiveSteps, db);
    if (err) return NextResponse.json({ error: err }, { status: 500 });
  }

  if (is_active) {
    // A concurrent activation may have closed a loop since publishChecks:
    // checked again under the lock; a refused new automation is removed.
    let chain: string[] | null;
    try {
      chain = await activateWithLoopLock(tenantOf(ctx), accountId, automation.id, {
        name: effectiveName,
        trigger_type: effectiveTriggerType,
        trigger_config: effectiveTriggerConfig ?? {},
        steps: effectiveSteps ?? [],
      });
    } catch (err) {
      // Refused (the plan's active cap): the new automation is removed, as on a loop.
      await db.from('automations').delete().eq('id', automation.id).eq('account_id', accountId);
      return toErrorResponse(err);
    }
    if (chain) {
      await db.from('automations').delete().eq('id', automation.id).eq('account_id', accountId);
      return loopRefusal(chain);
    }
    automation.is_active = true;
  }

  return NextResponse.json({ automation }, { status: 201 });
}

