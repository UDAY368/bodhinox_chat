import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getTemplate } from '@/lib/automations/templates';
import {
  insertSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';
import { automationTemplateIssues } from '@/lib/automations/template-check';
import { getT } from '@/lib/i18n/translate';
import { requireActiveAutomationRoom } from '@/lib/billing/activation';

const t = getT('Api');

export async function GET() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: t('common.unauthorized') },
      { status: 401 }
    );

  const { data, error } = await db
    .from('automations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ automations: data ?? [] });
}

export async function POST(request: Request) {
  // Use the authenticated tenant client; role and RLS both apply.
  try {
    await requireRole('agent');
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

  let effectiveSteps: BuilderStepInput[] | undefined = steps;
  let effectiveName = name;
  let effectiveDescription = description;
  let effectiveTriggerType = trigger_type;
  let effectiveTriggerConfig = trigger_config;

  if (template && (!steps || steps.length === 0)) {
    const tpl = getTemplate(template);
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

  // Block activation of a clearly broken automation up-front instead of
  // letting every trigger silently produce a failed log row. Drafts
  // (is_active=false) are allowed to be incomplete so users can save
  // progress mid-build.
  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(
        effectiveTriggerType,
        effectiveTriggerConfig ?? {},
        effectiveSteps ?? []
      ),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[]
      ),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        { error: t('automations.invalidActivateConfig'), issues },
        { status: 400 }
      );
    }
    try {
      await requireActiveAutomationRoom(accountId);
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
      is_active: !!is_active,
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

  return NextResponse.json({ automation }, { status: 201 });
}
