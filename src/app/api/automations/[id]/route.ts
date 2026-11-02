import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import type { DataClient } from '@/lib/data/types';
import {
  loadStepsTree,
  replaceSteps,
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

// Use the authenticated tenant client; role and RLS both apply.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Reading is open to any member (`automations_select` has no role
  // floor) but is still account-scoped.
  let accountId: string;
  let admin: DataClient;
  try {
    const ctx = await getCurrentAccount();
    accountId = ctx.accountId;
    admin = ctx.db;
  } catch (err) {
    return toErrorResponse(err);
  }

  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!automation)
    return NextResponse.json({ error: t('common.notFound') }, { status: 404 });

  const steps = await loadStepsTree(id, admin);
  return NextResponse.json({ automation, steps });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Use the authenticated tenant client; role and RLS both apply.
  let accountId: string;
  let admin: DataClient;
  try {
    const ctx = await requireRole('agent');
    accountId = ctx.accountId;
    admin = ctx.db;
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json(
      { error: t('common.invalidJson') },
      { status: 400 }
    );

  // Tenancy check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select('id, account_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k];
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean'
      ? update.is_active
      : existing.is_active;
  // A template step that needs more than body values would fail on
  // every run: refuse it on any save of new steps, and on activation of
  // the stored ones.
  const stepsToCheck = Array.isArray(body.steps)
    ? (body.steps as BuilderStepInput[])
    : willBeActive
      ? await loadStepsTree(id, admin)
      : [];
  const templateIssues = await automationTemplateIssues(
    admin,
    accountId,
    stepsToCheck
  );
  if (templateIssues.length > 0) {
    return NextResponse.json(
      { error: templateIssues[0].message, issues: templateIssues },
      { status: 400 }
    );
  }
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ??
      existing.trigger_type) as string;
    const mergedTriggerConfig =
      update.trigger_config ?? existing.trigger_config;
    const mergedSteps = stepsToCheck;
    const issues = [
      ...validateTriggerForActivation(
        mergedTriggerType,
        mergedTriggerConfig,
        mergedSteps
      ),
      ...validateStepsForActivation(mergedSteps),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: t('automations.invalidActiveConfig'),
          issues,
        },
        { status: 400 }
      );
    }
    // Only turning an automation on counts against the plan's active cap.
    if (update.is_active === true && !existing.is_active) {
      try {
        await requireActiveAutomationRoom(accountId, id);
      } catch (err) {
        return toErrorResponse(err);
      }
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId);
    if (updErr)
      return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[], admin);
    if (err) return NextResponse.json({ error: err }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Use the authenticated tenant client; role and RLS both apply.
  let accountId: string;
  let admin: DataClient;
  try {
    const ctx = await requireRole('agent');
    accountId = ctx.accountId;
    admin = ctx.db;
  } catch (err) {
    return toErrorResponse(err);
  }

  const { error } = await admin
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId);
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
